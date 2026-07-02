/** Test-Implementierungen von VaultPort/MetadataPort auf einer In-Memory-Map.
 *  Der Frontmatter-Parser ist ein bewusst kleines YAML-Subset (flache Keys, Skalare,
 *  Inline-/Block-Listen, Quoting) — genau das, was TaskNotes-Fixtures brauchen. Verschachtelte
 *  Strukturen (Team-Definitionen) werden per setFrontmatter-Override eingespeist, weil zur
 *  Laufzeit Obsidians metadataCache parst und wir fremdes YAML-Parsing nicht testen. */
import type { MetadataPort, VaultPort } from '../../src/core/ports';

export class InMemoryVaultPort implements VaultPort {
	readonly files = new Map<string, string>();

	async read(path: string): Promise<string> {
		const c = this.files.get(path);
		if (c === undefined) throw new Error(`not found: ${path}`);
		return c;
	}
	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`exists: ${path}`);
		this.files.set(path, content);
	}
	async modify(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}
	async append(path: string, content: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? '') + content);
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
	async mkdir(_path: string): Promise<void> {
		// Ordner sind in der Map implizit.
	}
	async patchFrontmatter(path: string, set: Record<string, string | number | null>, remove: string[]): Promise<void> {
		const raw = await this.read(path);
		const fm = splitFrontmatter(raw);
		const lines = fm ? fm.block.split('\n') : [];
		const out: string[] = [];
		const handled = new Set<string>();
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			const m = /^([A-Za-z0-9_-]+):/.exec(line);
			if (!m) { out.push(line); continue; }
			const key = m[1] ?? '';
			// Block-Listen-Folgezeilen gehören zur Key-Zeile.
			let j = i;
			while (j + 1 < lines.length && /^\s+(-|\s)/.test(lines[j + 1] ?? '')) j += 1;
			if (remove.includes(key)) { i = j; handled.add(key); continue; }
			if (key in set) {
				out.push(`${key}: ${serialize(set[key] ?? null)}`);
				i = j;
				handled.add(key);
				continue;
			}
			for (let k = i; k <= j; k++) out.push(lines[k] ?? '');
			i = j;
		}
		for (const [key, value] of Object.entries(set)) {
			if (!handled.has(key)) out.push(`${key}: ${serialize(value)}`);
		}
		const body = fm ? fm.body : raw;
		this.files.set(path, `---\n${out.join('\n')}\n---\n${body}`);
	}
}

export class FixtureMetadataPort implements MetadataPort {
	private overrides = new Map<string, Record<string, unknown>>();
	constructor(private vault: InMemoryVaultPort) {}

	setFrontmatter(path: string, fm: Record<string, unknown>): void {
		this.overrides.set(path, fm);
	}
	async listMarkdownFiles(folder: string): Promise<string[]> {
		const prefix = folder.endsWith('/') ? folder : `${folder}/`;
		return [...this.vault.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.md')).sort();
	}
	async getFrontmatter(path: string): Promise<Record<string, unknown> | null> {
		const o = this.overrides.get(path);
		if (o) return o;
		const fm = splitFrontmatter(await this.vault.read(path));
		return fm ? parseFlatYaml(fm.block) : null;
	}
	async getBody(path: string): Promise<string> {
		const raw = await this.vault.read(path);
		const fm = splitFrontmatter(raw);
		return fm ? fm.body : raw;
	}
}

function splitFrontmatter(raw: string): { block: string; body: string } | null {
	if (!raw.startsWith('---\n')) return null;
	const end = raw.indexOf('\n---\n', 4);
	if (end < 0) return null;
	return { block: raw.slice(4, end), body: raw.slice(end + 5) };
}

function serialize(v: string | number | null): string {
	if (v === null) return 'null';
	return String(v);
}

/** Flaches YAML-Subset für Fixtures — kein Anspruch auf Vollständigkeit. */
export function parseFlatYaml(block: string): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	const lines = block.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1] ?? '';
		const rest = (m[2] ?? '').trim();
		if (rest === '') {
			// Block-Liste (oder leerer Wert)
			const items: unknown[] = [];
			while (i + 1 < lines.length && /^\s+-/.test(lines[i + 1] ?? '')) {
				i += 1;
				const item = (lines[i] ?? '').replace(/^\s+-\s?/, '').trim();
				items.push(item === '' ? null : scalar(item));
			}
			obj[key] = items.length > 0 ? items : null;
			continue;
		}
		if (rest.startsWith('[') && rest.endsWith(']')) {
			const inner = rest.slice(1, -1).trim();
			obj[key] = inner === '' ? [] : inner.split(',').map((s) => scalar(s.trim()));
			continue;
		}
		obj[key] = scalar(rest);
	}
	return obj;
}

function scalar(s: string): unknown {
	if (s === 'null' || s === '~') return null;
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}
