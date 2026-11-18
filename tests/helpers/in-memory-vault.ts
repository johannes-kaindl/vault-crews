/** Test-Implementierungen von VaultPort/MetadataPort auf einer In-Memory-Map.
 *  Der Frontmatter-Parser ist ein bewusst kleines YAML-Subset (flache Keys, Skalare,
 *  Inline-/Block-Listen, Quoting) — genau das, was TaskNotes-Fixtures brauchen. Verschachtelte
 *  Strukturen (Team-Definitionen) werden per setFrontmatter-Override eingespeist, weil zur
 *  Laufzeit Obsidians metadataCache parst und wir fremdes YAML-Parsing nicht testen. */
import type { MetadataPort, VaultPort } from '../../src/core/ports';
import type { FmValue } from '../../src/core/types';

/** Obsidian's `app.vault.getAbstractFileByPath` (TFile-Index) does NOT index dotfiles —
 *  only `vault.adapter` (used by create/exists/mkdir) sees them. ObsidianVaultPort.read/
 *  modify resolve through that TFile index (see src/obsidian/vault-port.ts `file()`), so
 *  they throw at runtime for a dotfile path. Mirror that constraint here so tests exercise
 *  the real limitation instead of the InMemory map's uniform (and wrong) behaviour. */
function isDotfilePath(path: string): boolean {
	const segment = path.split('/').pop() ?? path;
	return segment.startsWith('.');
}

export class InMemoryVaultPort implements VaultPort {
	readonly files = new Map<string, string>();
	/** Pfade, die trash() in den Papierkorb verschoben hat (Undo-Tests prüfen darauf). */
	readonly trashed: string[] = [];
	/** Antwort von `linksFollowMoves()`: Obsidians Einstellung „Interne Links automatisch aktualisieren“ (Obsidians Standard ist aus; das Test-Double steht auf an, damit Läufe mit `note.move` ohne Zutun laufen). */
	linksFollow = true;

	linksFollowMoves(): boolean { return this.linksFollow; }

	async trash(path: string): Promise<void> {
		if (!this.files.has(path)) throw new Error(`not found: ${path}`);
		this.files.delete(path);
		this.trashed.push(path);
	}

	async read(path: string): Promise<string> {
		if (isDotfilePath(path)) throw new Error(`vault-crews: Datei nicht gefunden: ${path}`);
		const c = this.files.get(path);
		if (c === undefined) throw new Error(`not found: ${path}`);
		return c;
	}
	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`exists: ${path}`);
		this.assertParentFolder(path);
		this.files.set(path, content);
	}

	/** Opt-in, ab hier gilt wie in Obsidians `vault.create`: ein Elternordner muss als Ordner EXISTIEREN, sonst wirft
	 *  `create` (ENOENT). Die Map kennt Ordner sonst nur implizit — genau das verbarg den Fehler „erster Lauf ohne
	 *  `runs/`-Ordner" (Welle 20). Vorhandene Dateien machen ihre Ordner zu echten Ordnern; `mkdir` legt weitere an. */
	requireExistingFolders(): void {
		this.folders = new Set();
		for (const path of this.files.keys()) this.addFolders(path.split('/').slice(0, -1).join('/'));
	}
	private folders: Set<string> | null = null;
	private addFolders(dir: string): void {
		const parts = dir.split('/').filter((p) => p !== '');
		for (let i = 1; i <= parts.length; i++) this.folders?.add(parts.slice(0, i).join('/'));
	}
	private assertParentFolder(path: string): void {
		if (this.folders === null) return;
		const dir = path.split('/').slice(0, -1).join('/');
		if (dir !== '' && !this.folders.has(dir)) throw new Error(`ENOENT: Ordner existiert nicht: ${dir}`);
	}
	async modify(path: string, content: string): Promise<void> {
		if (isDotfilePath(path)) throw new Error(`vault-crews: Datei nicht gefunden: ${path}`);
		this.files.set(path, content);
	}
	/** Bytes aus `writeBinary` (der Mitschnitt `calls.jsonl.gz`); sie zählen für `exists`, nicht für `read`. */
	readonly binaries = new Map<string, Uint8Array>();
	/** Pfade, die `remove` entfernt hat (der Wächter-Test prüft, dass sie im Lauf-Ordner liegen). */
	readonly removed: string[] = [];
	async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
		this.assertParentFolder(path);
		this.binaries.set(path, bytes);
	}
	async remove(path: string): Promise<void> {
		this.removed.push(path);
		this.files.delete(path);
		this.binaries.delete(path);
	}
	async append(path: string, content: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? '') + content);
	}
	/** Wie Obsidians `adapter.exists`: eine Datei, ein Ordner, den `mkdir` angelegt hat oder `requireExistingFolders` führt, und ein Ordner, unter dem
	 *  eine Datei liegt, sind da. */
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.binaries.has(path) || this.isFolder(path);
	}
	private isFolder(path: string): boolean {
		if (path === '' ) return false;
		if (this.declared.has(path) || (this.folders?.has(path) ?? false)) return true;
		const prefix = `${path}/`;
		for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
		return false;
	}
	/** Die direkten Unterordner von `parent` (Pfade, sortiert): aus Dateien darunter und aus angelegten Ordnern. */
	folderChildren(parent: string): string[] {
		const prefix = parent === '' ? '' : `${parent}/`;
		const out = new Set<string>();
		const consider = (p: string): void => {
			if (!p.startsWith(prefix)) return;
			const first = p.slice(prefix.length).split('/')[0] ?? '';
			if (first !== '' && p.slice(prefix.length).includes('/')) out.add(`${prefix}${first}`);
		};
		for (const f of this.files.keys()) consider(f);
		for (const d of this.declared) consider(`${d}/`);
		return [...out].sort();
	}
	/** Verschiebt eine Datei wie `fileManager.renameFile`: die Quelle muss da, der Zielpfad frei und der Zielordner vorhanden sein. Links zieht der Fake nicht nach. */
	async rename(from: string, to: string): Promise<void> {
		const content = this.files.get(from);
		if (content === undefined) throw new Error(`not found: ${from}`);
		if (await this.exists(to)) throw new Error(`exists: ${to}`);
		const dir = to.split('/').slice(0, -1).join('/');
		if (dir !== '' && !this.isFolder(dir)) throw new Error(`ENOENT: Ordner existiert nicht: ${dir}`);
		this.files.delete(from);
		this.files.set(to, content);
	}
	private readonly declared = new Set<string>();
	async mkdir(path: string): Promise<void> {
		// Ordner sind in der Map implizit — außer nach `requireExistingFolders()`; `exists` kennt zusätzlich, was `mkdir` angelegt hat.
		const parts = path.split('/').filter((p) => p !== '');
		for (let i = 1; i <= parts.length; i++) this.declared.add(parts.slice(0, i).join('/'));
		this.addFolders(path);
	}
	async patchFrontmatter(path: string, set: Record<string, FmValue>, remove: string[], add?: Record<string, (string | number)[]>): Promise<void> {
		const raw = await this.read(path);
		const fm = splitFrontmatter(raw);
		if (add !== undefined) {
			// Vereinigung aus dem Stand der Datei in diesem Augenblick (wie der Adapter in processFrontMatter), exakt, ohne Normalisierung.
			const current = fm ? parseFlatYaml(fm.block) : {};
			set = { ...set };
			for (const [key, values] of Object.entries(add)) {
				const before = current[key];
				const merged: (string | number)[] = Array.isArray(before) ? [...before as (string | number)[]] : before === null || before === undefined ? [] : [before as string | number];
				for (const v of values) if (!merged.includes(v)) merged.push(v);
				set[key] = merged;
			}
		}
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
				out.push(...serializeFrontmatterLines(key, set[key] ?? null));
				i = j;
				handled.add(key);
				continue;
			}
			for (let k = i; k <= j; k++) out.push(lines[k] ?? '');
			i = j;
		}
		for (const [key, value] of Object.entries(set)) {
			if (!handled.has(key)) out.push(...serializeFrontmatterLines(key, value));
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
	/** Tags aus dem Frontmatter-Feld `tags` aller Dateien (ohne `#`), mit der Zahl der Notizen, die sie tragen. */
	async listFolders(parent: string): Promise<string[]> {
		return this.vault.folderChildren(parent.replace(/\/+$/, ''));
	}
	async listTags(): Promise<{ tag: string; count: number }[]> {
		const counts = new Map<string, number>();
		for (const [path, raw] of this.vault.files) {
			if (!path.endsWith('.md')) continue;
			const fm = this.overrides.get(path) ?? (splitFrontmatter(raw) ? parseFlatYaml(splitFrontmatter(raw)?.block ?? '') : null);
			const tags = fm?.tags;
			const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [];
			for (const t of new Set(list.filter((x): x is string => typeof x === 'string'))) {
				const tag = t.replace(/^#/, '');
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return [...counts].map(([tag, count]) => ({ tag, count }));
	}
	/** Dateinamen im Ordner (mit Unterordnern); ohne Änderungszeit im Fake: neueste Einfügung zuerst. */
	async recentNoteNames(folder: string, limit: number): Promise<string[]> {
		const prefix = folder === '' ? '' : folder.endsWith('/') ? folder : `${folder}/`;
		const paths = [...this.vault.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.md')).reverse();
		return paths.slice(0, limit).map((p) => (p.split('/').pop() ?? p).replace(/\.md$/, ''));
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

/** Rendert eine set()-Zeile für patchFrontmatter — Skalar bleibt `key: value`, ein Array
 *  wird als YAML-Block-Liste ausgegeben (`key:` + `  - item` je Zeile), symmetrisch zu
 *  parseFlatYaml's Block-Listen-Zweig oben, damit Listen-Werte round-tripen. */
function serializeFrontmatterLines(key: string, v: FmValue): string[] {
	if (Array.isArray(v)) {
		if (v.length === 0) return [`${key}:`];
		return [`${key}:`, ...v.map((item) => `  - ${serialize(item)}`)];
	}
	return [`${key}: ${serialize(v)}`];
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
