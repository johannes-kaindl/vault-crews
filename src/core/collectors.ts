/** Deterministische Kontext-Beschaffung (Spec §3.2/§4.2): Collectors laufen im Plugin,
 *  nie im LLM. Sie normalisieren YAML-Pathologien ([null]-Listen, fehlende Keys) und
 *  slugifizieren Enum-Werte, damit das Modell nie Emoji-Vokabular sieht. */
import { isDenied, normalizeVaultPath } from './paths';
import { buildSlugTable, isEnumField } from './slug-mapper';
import type { MetadataPort, VaultPort } from './ports';
import type { Artifact, CollectedFile, CollectorTaskDef, SlugTableData } from './types';

const PER_FILE_CAP = 32_768;
const TOTAL_CAP = 262_144;
const TRUNCATION_MARKER = '\n[gekürzt]';

export interface CollectorDeps { vault: VaultPort; meta: MetadataPort; denylist: string[]; }

export function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** Kürzt Notiz-Inhalt auf die Per-File- und Total-Caps. Geteilt von vault.read und
 *  tasknotes.query#include_content. Gibt gekürzten Text + neue Laufsumme zurück. */
function capContent(full: string, runningTotal: number): { content: string; total: number } {
	let content = full;
	if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + TRUNCATION_MARKER;
	if (runningTotal + content.length > TOTAL_CAP) content = content.slice(0, Math.max(0, TOTAL_CAP - runningTotal)) + TRUNCATION_MARKER;
	return { content, total: runningTotal + content.length };
}

export async function runCollector(def: CollectorTaskDef, deps: CollectorDeps): Promise<Artifact> {
	switch (def.collector) {
		case 'vault.list': return vaultList(def, deps);
		case 'vault.read': return vaultRead(def, deps);
		case 'tasknotes.query': return tasknotesQuery(def, deps);
	}
}

function artifact(taskId: string, files: CollectedFile[], slugTables: Record<string, SlugTableData> = {}): Artifact {
	return { taskId, json: { files }, files, slugTables };
}

async function vaultList(def: CollectorTaskDef, deps: CollectorDeps): Promise<Artifact> {
	const folder = str(def.params.folder) ?? '';
	const limit = num(def.params.limit) ?? 100;
	const paths = (await deps.meta.listMarkdownFiles(folder))
		.map(normalizeVaultPath)
		.filter((p) => !isDenied(p, deps.denylist))
		.slice(0, limit);
	const files: CollectedFile[] = [];
	for (const path of paths) {
		files.push({ path, contentHash: fnv1a(await deps.vault.read(path)), frontmatter: null, content: null });
	}
	return artifact(def.id, files);
}

async function vaultRead(def: CollectorTaskDef, deps: CollectorDeps): Promise<Artifact> {
	const wanted = Array.isArray(def.params.paths) ? def.params.paths.filter((p): p is string => typeof p === 'string') : [];
	const files: CollectedFile[] = [];
	let total = 0;
	for (const raw of wanted) {
		const path = normalizeVaultPath(raw);
		if (isDenied(path, deps.denylist) || !(await deps.vault.exists(path))) continue;
		const full = await deps.vault.read(path);
		const capped = capContent(full, total);
		total = capped.total;
		files.push({
			path,
			contentHash: fnv1a(full),
			frontmatter: await deps.meta.getFrontmatter(path),
			content: capped.content,
		});
		if (total >= TOTAL_CAP) break;
	}
	return artifact(def.id, files);
}

async function tasknotesQuery(def: CollectorTaskDef, deps: CollectorDeps): Promise<Artifact> {
	const folder = str(def.params.folder) ?? '';
	const where = isRecord(def.params.where) ? def.params.where : {};
	const whereMissing = Array.isArray(def.params.where_missing)
		? def.params.where_missing.filter((k): k is string => typeof k === 'string') : [];
	const sortKey = str(def.params.sort);
	const limit = num(def.params.limit) ?? 100;
	const fields = Array.isArray(def.params.fields)
		? def.params.fields.filter((f): f is string => typeof f === 'string') : null;

	const paths = (await deps.meta.listMarkdownFiles(folder))
		.map(normalizeVaultPath)
		.filter((p) => !isDenied(p, deps.denylist));

	// 1. Alle Frontmatter laden + normalisieren (Basis für SlugTables UND Filter).
	const entries: { path: string; fm: Record<string, unknown>; raw: string }[] = [];
	for (const path of paths) {
		const fm = normalizeFm(await deps.meta.getFrontmatter(path));
		entries.push({ path, fm, raw: await deps.vault.read(path) });
	}

	// 2. SlugTables je String-wertigem Key über die Ist-Werte des Ordners (Spec §2.5.2).
	const slugTables: Record<string, SlugTableData> = {};
	const keys = new Set<string>([...Object.keys(where), ...(fields ?? entries.flatMap((e) => Object.keys(e.fm)))]);
	for (const key of keys) {
		const values = entries
			.flatMap((e) => (Array.isArray(e.fm[key]) ? (e.fm[key] as unknown[]) : [e.fm[key]]))
			.filter((v): v is string => typeof v === 'string' && v !== '');
		if (isEnumField(values)) slugTables[key] = buildSlugTable(values);
	}

	// 3. Filtern auf Slug-Ebene.
	const matches = entries.filter((e) => {
		for (const [key, wanted] of Object.entries(where)) {
			const allowed = Array.isArray(wanted) ? wanted.filter((w): w is string => typeof w === 'string') : [];
			const values = (Array.isArray(e.fm[key]) ? (e.fm[key] as unknown[]) : [e.fm[key]])
				.filter((v): v is string => typeof v === 'string')
				.map((v) => slugTables[key]?.toSlug[v] ?? v);
			if (!values.some((v) => allowed.includes(v))) return false;
		}
		for (const key of whereMissing) {
			const v = e.fm[key];
			if (!(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) return false;
		}
		return true;
	});

	// 4. Sortieren (deterministisch, Pfad als Tiebreaker) + Limit.
	matches.sort((a, b) => {
		if (sortKey) {
			const av = sortValue(a.fm[sortKey]);
			const bv = sortValue(b.fm[sortKey]);
			if (av !== bv) return av < bv ? -1 : 1;
		}
		return a.path < b.path ? -1 : 1;
	});
	const limited = matches.slice(0, limit);

	// 5. Projektion + Slug-Normalisierung; optional Inhalt (include_content).
	const includeContent = def.params.include_content === true;
	const files: CollectedFile[] = [];
	let contentTotal = 0;
	for (const e of limited) {
		const projected: Record<string, unknown> = {};
		for (const key of fields ?? Object.keys(e.fm)) {
			if (!(key in e.fm)) { projected[key] = null; continue; }
			projected[key] = slugify(e.fm[key], slugTables[key]);
		}
		let content: string | null = null;
		if (includeContent) {
			const capped = capContent(e.raw, contentTotal);
			content = capped.content;
			contentTotal = capped.total;
		}
		files.push({ path: e.path, contentHash: fnv1a(e.raw), frontmatter: projected, content });
	}
	return artifact(def.id, files, slugTables);
}

function normalizeFm(fm: Record<string, unknown> | null): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm ?? {})) {
		out[k] = Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : v ?? null;
	}
	return out;
}

function slugify(v: unknown, table: SlugTableData | undefined): unknown {
	if (typeof v === 'string') return table?.toSlug[v] ?? v;
	if (Array.isArray(v)) return (v as unknown[]).map((x: unknown) => (typeof x === 'string' ? table?.toSlug[x] ?? x : x));
	return v;
}

function sortValue(v: unknown): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return String(v);
	return '';
}

function str(v: unknown): string | null { return typeof v === 'string' && v !== '' ? v : null; }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null; }
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
