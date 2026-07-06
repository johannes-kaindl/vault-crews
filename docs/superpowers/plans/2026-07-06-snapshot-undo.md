# Snapshot-Undo (0.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ersetze das git-gekoppelte Undo (child_process + node:fs) durch ein plugin-eigenes Snapshot-/Quarantäne-Undo über die Obsidian-Vault-/Adapter-API — funktioniert in jedem Vault, entfernt beide Store-Review-„Behavior"-Warnings.

**Architecture:** Copy-on-Write write-ahead: ein `preWrite`-Hook in Phase 2 des ActionExecutors snapshottet jeden Pfad-Pre-Image (first-write-wins) auf Platte, bevor der Vault-Write passiert. Ein Adapter-Store unter `.obsidian/plugins/vault-crews/undo/<runId>/` hält Manifest + Blobs. Das löschungsfreie Aktions-Set macht Undo trivial: geänderte Notes aus Blob restaurieren, erzeugte Notes in den Papierkorb. Ein purer `buildUndoPlan` (spiegelt den bestehenden `git-plan.ts`-Split) berechnet restores/deletes/conflicts; `fnv1a` erkennt seit dem Lauf editierte Notes.

**Tech Stack:** TypeScript, Obsidian Plugin API (`app.vault.adapter`, `app.fileManager.trashFile`), esbuild, Vitest (node-env, Obsidian-Mock via `resolve.alias`).

## Global Constraints

- **Harte Randbedingung:** kein `child_process`, kein `node:fs`, kein `node:*`. Ausschließlich Obsidian-Vault-/Adapter-API.
- **`src/core/**` importiert NIE `obsidian`** — CI-Gate `npm run check:pure` (grep). Ports injiziert.
- **Gate vor jedem Commit grün:** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen, nicht grep-Ausgabe.
- **TDD:** erst der fehlschlagende Test, dann Minimal-Implementierung.
- **Commit-Style:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** `feat/snapshot-undo` (bereits angelegt; Spec committet als `861d383`).
- **Papierkorb, nie Hard-Delete:** erzeugte Notes gehen über `app.fileManager.trashFile`.
- **`fnv1a` wiederverwenden** aus `src/core/collectors.ts` (`import { fnv1a } from './collectors'`) — nicht neu implementieren.

---

## File Structure

**Neu:**
- `src/core/undo-plan.ts` — purer Undo-Planer (`buildUndoPlan`). Spiegelt `git-plan.ts`.
- `src/obsidian/snapshot-store.ts` — `AdapterSnapshotStore` über `app.vault.adapter`.
- `tests/core/undo-plan.test.ts`, `tests/obsidian/snapshot-store.test.ts`.

**Geändert:**
- `src/core/ports.ts` — `SnapshotStore`/`SnapshotEntry`/`SnapshotManifest` rein, `VaultPort.trash` rein; `GitPort`/`GitStatusInfo`/`CommitPlan` bleiben bis Task 6 als toter Code stehen.
- `src/core/types.ts` — `RunState.baseSha`/`commitSha` raus; `RunResult.undoable` (ersetzt `commitSha`).
- `src/core/action-executor.ts` — `ExecutorContext.preWrite?`-Hook, Aufruf in Phase 2.
- `src/core/orchestrator.ts` — `checkGit()` raus, `RunDeps.git`→`snapshot`, `commit()`→`finalize()`, `undoable`.
- `src/core/run-log.ts` — `commit:`-Zeile + git-revert-Footer → Snapshot-Wording; `undone`-Marker.
- `src/obsidian/recovery.ts` — `RecoveryDeps.git` raus, `finish()` ohne Commit.
- `src/obsidian/vault-port.ts` — `trash()`-Impl.
- `src/main.ts` — Port-Wiring, Run-Deps, `undoable`, `startUndo`/`performUndo` gegen Snapshot, `lastRuns`-Migration.
- `src/obsidian/settings.ts` — `undoHistoryDepth`-Setting.
- `src/i18n/strings.ts` — undo/recovery-Vokabular entkoppelt von git; Konflikt-Keys.

**Gelöscht (Task 6):**
- `src/obsidian/git-port.ts`, `src/core/git-plan.ts` + zugehörige Tests.

---

## Task 1: Purer Undo-Planer + Snapshot-Port-Verträge

Rein additiv — kein bestehender Code ändert Verhalten, Build bleibt grün.

**Files:**
- Modify: `src/core/ports.ts` (Verträge hinzufügen)
- Create: `src/core/undo-plan.ts`
- Test: `tests/core/undo-plan.test.ts`

**Interfaces:**
- Consumes: `fnv1a` aus `src/core/collectors.ts`.
- Produces:
  - `SnapshotEntry { path: string; existedBefore: boolean; preHash: string | null; postHash: string | null; blob: string | null }`
  - `SnapshotManifest { runId: string; teamId: string; createdAt: number; entries: SnapshotEntry[] }`
  - `SnapshotStore` (Interface, siehe Code)
  - `buildUndoPlan(manifest, currentContents, blobs): UndoPlan`
  - `UndoPlan { restores: { path: string; content: string }[]; deletes: string[]; conflicts: string[] }`

- [ ] **Step 1: Verträge in `src/core/ports.ts` ergänzen**

Nach dem bestehenden `CommitPlan`/`GitPort`-Block (ports.ts:66–72) einfügen (GitPort NICHT entfernen):

```ts
export interface SnapshotEntry {
	path: string;
	existedBefore: boolean;
	preHash: string | null;   // fnv1a des Pre-Image (null gdw. !existedBefore)
	postHash: string | null;  // fnv1a des Post-Run-Inhalts (finalize; null nach Crash)
	blob: string | null;      // Blob-Dateiname (null gdw. !existedBefore)
}
export interface SnapshotManifest {
	runId: string;
	teamId: string;
	createdAt: number;
	entries: SnapshotEntry[];
}
export interface SnapshotStore {
	/** Pre-Image erfassen; first-write-wins (no-op, wenn Pfad im Lauf schon erfasst).
	 *  Persistiert Blob + Manifest write-ahead. */
	capture(runId: string, teamId: string, createdAt: number, path: string, existedBefore: boolean, preContent: string | null): Promise<void>;
	/** Post-Run-Hashes nachtragen + Retention auf keepLast Läufe prunen. */
	finalize(runId: string, postHashes: Record<string, string>, keepLast: number): Promise<void>;
	load(runId: string): Promise<SnapshotManifest | null>;
	readBlob(runId: string, blob: string): Promise<string>;
	discard(runId: string): Promise<void>;
	list(): Promise<string[]>;
}
```

Und `VaultPort` (ports.ts:5–13) um eine Methode erweitern:

```ts
	/** Datei in den Obsidian-Papierkorb verschieben (fileManager.trashFile) — nie Hard-Delete. */
	trash(path: string): Promise<void>;
```

- [ ] **Step 2: Fehlschlagenden Test schreiben** — `tests/core/undo-plan.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildUndoPlan } from '../../src/core/undo-plan';
import { fnv1a } from '../../src/core/collectors';
import type { SnapshotManifest } from '../../src/core/ports';

function manifest(entries: SnapshotManifest['entries']): SnapshotManifest {
	return { runId: '2026-07-06-1200-t', teamId: 't', createdAt: 0, entries };
}

describe('buildUndoPlan', () => {
	it('restauriert eine geänderte Existenz-Note aus ihrem Blob', () => {
		const pre = '# vorher\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('# nachher\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': '# nachher\n' }, { '0.snapshot': pre });
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
		expect(plan.deletes).toEqual([]);
		expect(plan.conflicts).toEqual([]);
	});

	it('löscht eine vom Lauf erzeugte Note (existedBefore=false, kein Blob)', () => {
		const m = manifest([{ path: 'neu.md', existedBefore: false, preHash: null, postHash: fnv1a('x'), blob: null }]);
		const plan = buildUndoPlan(m, { 'neu.md': 'x' }, {});
		expect(plan.deletes).toEqual(['neu.md']);
		expect(plan.restores).toEqual([]);
	});

	it('markiert einen Pfad als conflict, wenn der aktuelle Inhalt ≠ postHash ist', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('vom-lauf\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': 'user-hat-editiert\n' }, { '0.snapshot': pre });
		expect(plan.conflicts).toEqual(['a.md']);
		// conflict blockiert nicht — restore bleibt im Plan:
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});

	it('zählt einen Crash-Eintrag (postHash=null) NICHT als conflict', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: null, blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': 'irgendwas\n' }, { '0.snapshot': pre });
		expect(plan.conflicts).toEqual([]);
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});

	it('restauriert eine seit dem Lauf gelöschte Existenz-Note (current=null) via create', () => {
		const pre = 'alt\n';
		const m = manifest([{ path: 'a.md', existedBefore: true, preHash: fnv1a(pre), postHash: fnv1a('vom-lauf\n'), blob: '0.snapshot' }]);
		const plan = buildUndoPlan(m, { 'a.md': null }, { '0.snapshot': pre });
		// current=null && postHash gesetzt → seit dem Lauf entfernt → conflict-Warnung, restore trotzdem:
		expect(plan.conflicts).toEqual(['a.md']);
		expect(plan.restores).toEqual([{ path: 'a.md', content: pre }]);
	});
});
```

- [ ] **Step 3: Test ausführen, Fehlschlag verifizieren**

Run: `npx vitest run tests/core/undo-plan.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/undo-plan'`.

- [ ] **Step 4: `src/core/undo-plan.ts` implementieren**

```ts
/** Purer Undo-Planer (Design-Spec §4): berechnet aus einem SnapshotManifest + den
 *  aktuellen Inhalten die Rollback-Operationen. Spiegelt den git-plan.ts-Split —
 *  I/O macht der Aufrufer (main.ts über VaultPort + SnapshotStore), hier lebt nur Logik.
 *  Import von obsidian ist verboten (check:pure). */
import { fnv1a } from './collectors';
import type { SnapshotManifest } from './ports';

export interface UndoPlan {
	restores: { path: string; content: string }[]; // existedBefore=true → Pre-Image zurückschreiben
	deletes: string[];                              // existedBefore=false → in Papierkorb
	conflicts: string[];                            // Warn-Overlay (Teilmenge von restores/deletes)
}

/**
 * @param currentContents Pfad → aktueller Inhalt (null = existiert nicht mehr).
 * @param blobs           Blob-Name → Pre-Image-Inhalt.
 * conflict gdw. postHash!=null && (current===null || fnv1a(current) !== postHash) —
 * die Note wurde seit dem Lauf editiert/entfernt. postHash===null (Crash) → nie conflict.
 */
export function buildUndoPlan(
	manifest: SnapshotManifest,
	currentContents: Record<string, string | null>,
	blobs: Record<string, string>,
): UndoPlan {
	const restores: { path: string; content: string }[] = [];
	const deletes: string[] = [];
	const conflicts: string[] = [];

	for (const e of manifest.entries) {
		const current = e.path in currentContents ? currentContents[e.path] : null;
		if (e.postHash !== null) {
			const changed = current === null || fnv1a(current) !== e.postHash;
			if (changed) conflicts.push(e.path);
		}
		if (e.existedBefore) {
			const content = e.blob !== null ? (blobs[e.blob] ?? '') : '';
			restores.push({ path: e.path, content });
		} else {
			deletes.push(e.path);
		}
	}
	return { restores, deletes, conflicts };
}
```

- [ ] **Step 5: Test ausführen, Grün verifizieren**

Run: `npx vitest run tests/core/undo-plan.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 6: Gate + Commit**

```bash
npm run gate
git add src/core/ports.ts src/core/undo-plan.ts tests/core/undo-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(undo): purer buildUndoPlan + SnapshotStore-Verträge

restore|delete|conflict aus SnapshotManifest; fnv1a-Konflikterkennung
(postHash!=null && current≠post → seit dem Lauf editiert), Crash-Einträge
(postHash=null) nie als conflict. VaultPort.trash-Vertrag ergänzt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: gate grün (Exit 0).

---

## Task 2: VaultPort.trash-Impl + AdapterSnapshotStore

Rein additiv. Der Store lebt in `src/obsidian/` (darf `obsidian` importieren).

**Files:**
- Modify: `src/obsidian/vault-port.ts` (`trash`-Impl in `ObsidianVaultPort`)
- Create: `src/obsidian/snapshot-store.ts`
- Test: `tests/obsidian/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `SnapshotStore`, `SnapshotManifest` aus `ports.ts`; `fnv1a` aus `collectors.ts`; `app.vault.adapter` (`read`/`write`/`exists`/`mkdir`/`list`/`rmdir`/`remove`), `app.fileManager.trashFile`.
- Produces: `class AdapterSnapshotStore implements SnapshotStore` (Konstruktor `(app: App)`).

- [ ] **Step 1: `trash()` in `ObsidianVaultPort` ergänzen** (`src/obsidian/vault-port.ts`, nach `patchFrontmatter`)

```ts
	async trash(path: string): Promise<void> {
		const f = this.file(path); // wirft, wenn nicht vorhanden — Aufrufer prüft vorher via exists()
		// trashFile respektiert die Papierkorb-Einstellung des Users (System/.trash/lokal).
		await this.app.fileManager.trashFile(f);
	}
```

- [ ] **Step 2: Adapter-Mock im Obsidian-Mock bereitstellen**

Prüfe `tests/__mocks__/obsidian.ts`: falls `App`/`DataAdapter` dort keinen `adapter` mit `read/write/exists/mkdir/list/rmdir/remove` bietet, ergänze eine leichte In-Memory-Fake (nur was der Test braucht). Falls der Mock bereits eine `App`-Fabrik hat, dort `vault.adapter` andocken. (Der Test unten baseline-t das über eine eigene Fake-App — siehe Step 3 —, sodass keine globale Mock-Änderung nötig ist, wenn `AdapterSnapshotStore` nur `app.vault.adapter` liest.)

- [ ] **Step 3: Fehlschlagenden Test schreiben** — `tests/obsidian/snapshot-store.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterSnapshotStore } from '../../src/obsidian/snapshot-store';
import { fnv1a } from '../../src/core/collectors';

/** Minimaler In-Memory-DataAdapter (nur die vom Store genutzten Methoden). */
class FakeAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
	async mkdir(p: string) { this.dirs.add(p); }
	async read(p: string) { const v = this.files.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v; }
	async write(p: string, d: string) { this.files.set(p, d); }
	async remove(p: string) { this.files.delete(p); }
	async rmdir(p: string, _r: boolean) { this.dirs.delete(p); for (const k of [...this.files.keys()]) if (k.startsWith(p + '/')) this.files.delete(k); }
	async list(p: string) {
		const folders = new Set<string>();
		for (const k of this.files.keys()) { if (k.startsWith(p + '/')) { const rest = k.slice(p.length + 1); const seg = rest.split('/')[0]; folders.add(p + '/' + seg); } }
		for (const d of this.dirs) { if (d.startsWith(p + '/')) { const rest = d.slice(p.length + 1); const seg = rest.split('/')[0]; folders.add(p + '/' + seg); } }
		return { files: [], folders: [...folders] };
	}
}
function fakeApp() { const adapter = new FakeAdapter(); return { app: { vault: { adapter, configDir: '.obsidian' } } as any, adapter }; }

describe('AdapterSnapshotStore', () => {
	let store: AdapterSnapshotStore;
	let adapter: FakeAdapter;
	beforeEach(() => { const f = fakeApp(); store = new AdapterSnapshotStore(f.app); adapter = f.adapter; });

	it('capture schreibt Blob + Manifest write-ahead; load liest es zurück', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		const m = await store.load('R1');
		expect(m).not.toBeNull();
		expect(m!.entries).toHaveLength(1);
		expect(m!.entries[0]).toMatchObject({ path: 'a.md', existedBefore: true, preHash: fnv1a('alt\n'), postHash: null });
		expect(await store.readBlob('R1', m!.entries[0].blob!)).toBe('alt\n');
	});

	it('capture ist first-write-wins pro Pfad im selben Lauf', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'erste\n');
		await store.capture('R1', 'team', 100, 'a.md', true, 'zweite\n');
		const m = await store.load('R1');
		expect(m!.entries).toHaveLength(1);
		expect(await store.readBlob('R1', m!.entries[0].blob!)).toBe('erste\n');
	});

	it('capture einer erzeugten Note (existedBefore=false) legt keinen Blob an', async () => {
		await store.capture('R1', 'team', 100, 'neu.md', false, null);
		const m = await store.load('R1');
		expect(m!.entries[0]).toMatchObject({ existedBefore: false, blob: null, preHash: null });
	});

	it('finalize trägt postHashes nach', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		await store.finalize('R1', { 'a.md': fnv1a('neu\n') }, 15);
		const m = await store.load('R1');
		expect(m!.entries[0].postHash).toBe(fnv1a('neu\n'));
	});

	it('finalize pruned auf keepLast Läufe (ältere runIds werden verworfen)', async () => {
		for (const id of ['2026-07-01-0900-t', '2026-07-02-0900-t', '2026-07-03-0900-t']) {
			await store.capture(id, 't', 0, 'a.md', true, 'x\n');
		}
		await store.finalize('2026-07-03-0900-t', {}, 2);
		const ids = (await store.list()).sort();
		expect(ids).toEqual(['2026-07-02-0900-t', '2026-07-03-0900-t']);
	});

	it('discard entfernt einen Snapshot; load liefert danach null', async () => {
		await store.capture('R1', 'team', 100, 'a.md', true, 'alt\n');
		await store.discard('R1');
		expect(await store.load('R1')).toBeNull();
	});

	it('load liefert null für unbekannten Lauf', async () => {
		expect(await store.load('unbekannt')).toBeNull();
	});
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag verifizieren**

Run: `npx vitest run tests/obsidian/snapshot-store.test.ts`
Expected: FAIL — `Cannot find module '../../src/obsidian/snapshot-store'`.

- [ ] **Step 5: `src/obsidian/snapshot-store.ts` implementieren**

```ts
/** SnapshotStore über app.vault.adapter (Design-Spec §3/§4): der Store liegt versteckt
 *  unter <configDir>/plugins/vault-crews/undo/ und ist NICHT im TFile-Index — daher
 *  Adapter-I/O (nicht vault.read/modify). Manifest wird write-ahead pro capture
 *  neu geschrieben (crash-sicher). Kein child_process/node:fs — reine Obsidian-API. */
import type { App } from 'obsidian';
import { fnv1a } from '../core/collectors';
import type { SnapshotManifest, SnapshotStore } from '../core/ports';

export class AdapterSnapshotStore implements SnapshotStore {
	constructor(private readonly app: App) {}

	private get adapter() { return this.app.vault.adapter; }
	private root(): string { return `${this.app.vault.configDir}/plugins/vault-crews/undo`; }
	private runDir(runId: string): string { return `${this.root()}/${runId}`; }
	private manifestPath(runId: string): string { return `${this.runDir(runId)}/manifest.json`; }
	private blobPath(runId: string, blob: string): string { return `${this.runDir(runId)}/blobs/${blob}`; }

	async capture(runId: string, teamId: string, createdAt: number, path: string, existedBefore: boolean, preContent: string | null): Promise<void> {
		const manifest = (await this.load(runId)) ?? { runId, teamId, createdAt, entries: [] };
		if (manifest.entries.some((e) => e.path === path)) return; // first-write-wins

		let blob: string | null = null;
		let preHash: string | null = null;
		if (existedBefore && preContent !== null) {
			blob = `${manifest.entries.length}.snapshot`;
			preHash = fnv1a(preContent);
			await this.ensureDir(`${this.runDir(runId)}/blobs`);
			await this.adapter.write(this.blobPath(runId, blob), preContent);
		}
		manifest.entries.push({ path, existedBefore, preHash, postHash: null, blob });
		await this.ensureDir(this.runDir(runId));
		await this.adapter.write(this.manifestPath(runId), JSON.stringify(manifest, null, 2));
	}

	async finalize(runId: string, postHashes: Record<string, string>, keepLast: number): Promise<void> {
		const manifest = await this.load(runId);
		if (manifest !== null) {
			for (const e of manifest.entries) {
				const h = postHashes[e.path];
				if (h !== undefined) e.postHash = h;
			}
			await this.adapter.write(this.manifestPath(runId), JSON.stringify(manifest, null, 2));
		}
		await this.prune(keepLast);
	}

	async load(runId: string): Promise<SnapshotManifest | null> {
		try {
			if (!(await this.adapter.exists(this.manifestPath(runId)))) return null;
			return JSON.parse(await this.adapter.read(this.manifestPath(runId))) as SnapshotManifest;
		} catch {
			return null;
		}
	}

	async readBlob(runId: string, blob: string): Promise<string> {
		return this.adapter.read(this.blobPath(runId, blob));
	}

	async discard(runId: string): Promise<void> {
		try {
			if (await this.adapter.exists(this.runDir(runId))) await this.adapter.rmdir(this.runDir(runId), true);
		} catch { /* best effort */ }
	}

	async list(): Promise<string[]> {
		try {
			if (!(await this.adapter.exists(this.root()))) return [];
			const listed = await this.adapter.list(this.root());
			return listed.folders.map((f) => f.split('/').pop() ?? f);
		} catch {
			return [];
		}
	}

	private async prune(keepLast: number): Promise<void> {
		const ids = (await this.list()).sort(); // runId ist zeitpräfixiert → lexikografisch = chronologisch
		const drop = ids.slice(0, Math.max(0, ids.length - keepLast));
		for (const id of drop) await this.discard(id);
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}
}
```

- [ ] **Step 6: Test ausführen, Grün verifizieren**

Run: `npx vitest run tests/obsidian/snapshot-store.test.ts`
Expected: PASS (7 Tests). Falls der Obsidian-Mock kein `fileManager.trashFile` kennt und der Typecheck über `vault-port.ts` bricht, ergänze `trashFile` im Mock (no-op).

- [ ] **Step 7: Gate + Commit**

```bash
npm run gate
git add src/obsidian/vault-port.ts src/obsidian/snapshot-store.ts tests/obsidian/snapshot-store.test.ts tests/__mocks__/obsidian.ts
git commit -m "$(cat <<'EOF'
feat(undo): AdapterSnapshotStore + VaultPort.trash

Write-ahead Manifest/Blobs unter <configDir>/plugins/vault-crews/undo/ über
app.vault.adapter; first-write-wins, finalize trägt postHashes nach + pruned
auf keepLast. trash über fileManager.trashFile (Papierkorb, kein Hard-Delete).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: preWrite-Hook im ActionExecutor

Rein additiv (`preWrite` optional). Bestehende Executor-Tests bleiben grün.

**Files:**
- Modify: `src/core/action-executor.ts` (`ExecutorContext.preWrite?`, Aufruf in Phase 2)
- Test: `tests/core/action-executor.test.ts` (bestehend — Fälle ergänzen)

**Interfaces:**
- Produces: `ExecutorContext.preWrite?: (path: string) => Promise<void>` — vor jedem angewandten Write aufgerufen, mit dem aufgelösten `v.path`.

- [ ] **Step 1: Fehlschlagende Tests ergänzen** (`tests/core/action-executor.test.ts`)

Am Ende der Datei einen neuen `describe`-Block einfügen. (Nutze die im Datei-Kopf vorhandenen Helfer/Fixtures; falls es dort eine `ctx`-Fabrik gibt, diese verwenden — sonst analog zu bestehenden Tests eine `ExecutorContext` bauen.)

```ts
describe('preWrite-Hook', () => {
	it('feuert vor jedem angewandten Write mit dem aufgelösten Pfad', async () => {
		const seen: string[] = [];
		const vault = makeVault({ 'ordner/a.md': 'alt\n' }); // Helfer wie in bestehenden Tests
		const ctx = makeCtx({ allowedActions: ['note.append'], writeScope: ['ordner/**'], preWrite: async (p) => { seen.push(p); } });
		await executeActions([{ type: 'note.append', path: 'ordner/a.md', heading: null, content: 'neu' }], ctx, vault);
		expect(seen).toEqual(['ordner/a.md']);
	});

	it('feuert NICHT für rejected/stale Aktionen', async () => {
		const seen: string[] = [];
		const vault = makeVault({});
		const ctx = makeCtx({ allowedActions: ['note.append'], writeScope: ['ordner/**'], preWrite: async (p) => { seen.push(p); } });
		// Ziel existiert nicht → note.append failed, kein Write:
		await executeActions([{ type: 'note.append', path: 'ordner/fehlt.md', heading: null, content: 'x' }], ctx, vault);
		expect(seen).toEqual([]);
	});

	it('ein preWrite-Throw macht die Aktion failed (kein Write ohne Snapshot)', async () => {
		const vault = makeVault({ 'ordner/a.md': 'alt\n' });
		const ctx = makeCtx({ allowedActions: ['note.append'], writeScope: ['ordner/**'], preWrite: async () => { throw new Error('snapshot-io'); } });
		const { outcomes, writes } = await executeActions([{ type: 'note.append', path: 'ordner/a.md', heading: null, content: 'neu' }], ctx, vault);
		expect(writes).toEqual([]);
		expect(outcomes[0]).toMatchObject({ result: 'failed' });
		expect(await vault.read('ordner/a.md')).toBe('alt\n'); // Original unangetastet
	});
});
```

> **Hinweis für den Executor:** Prüfe die vorhandenen Test-Helfer (`makeVault`/`makeCtx` o. ä.) im Datei-Kopf und passe die Namen an. Existiert keine `makeCtx`-Fabrik, ergänze `preWrite` beim direkten `ExecutorContext`-Literal (`preWrite: …`).

- [ ] **Step 2: Test ausführen, Fehlschlag verifizieren**

Run: `npx vitest run tests/core/action-executor.test.ts -t preWrite`
Expected: FAIL — `preWrite` existiert nicht bzw. wird nie aufgerufen.

- [ ] **Step 3: `ExecutorContext` erweitern** (`src/core/action-executor.ts:12-22`)

Nach `denylist: string[];` ergänzen:

```ts
	/** Copy-on-Write-Hook (Design-Spec §6): vor jedem ANGEWANDTEN Write mit dem
	 *  aufgelösten Pfad aufgerufen — der Orchestrator snapshottet hier den Pre-Image.
	 *  Ein Throw wird wie ein Write-Fehler behandelt (Aktion failed). Optional:
	 *  Tests/Läufe ohne Undo lassen ihn weg. */
	preWrite?: (path: string) => Promise<void>;
```

- [ ] **Step 4: Hook in Phase 2 aufrufen** (`src/core/action-executor.ts:265-278`, im `for (const v of validated)`-Apply-Zweig)

Ersetze den `try { await applyAction… }`-Block durch:

```ts
		try {
			if (ctx.preWrite) await ctx.preWrite(v.path); // Pre-Image sichern, BEVOR geschrieben wird
			await applyAction(v, ctx, vault);
			if (!writes.includes(v.path)) writes.push(v.path);
			outcomes.push({ action: v.action, result: 'applied', reason: null });
		} catch (e) {
			taskFailed = true;
			outcomes.push(outcomeOf(v.action, 'failed', `io: ${e instanceof Error ? e.message : String(e)}`));
		}
```

- [ ] **Step 5: Tests ausführen, Grün verifizieren**

Run: `npx vitest run tests/core/action-executor.test.ts`
Expected: PASS (alle bestehenden + 3 neue).

- [ ] **Step 6: Gate + Commit**

```bash
npm run gate
git add src/core/action-executor.ts tests/core/action-executor.test.ts
git commit -m "$(cat <<'EOF'
feat(undo): preWrite-Hook in Executor-Phase-2

Copy-on-Write-Naht: vor jedem angewandten Write mit dem aufgelösten Pfad
aufgerufen; Throw → Aktion failed (nie Write ohne Snapshot). Optional,
rejected/stale-Aktionen feuern ihn nicht.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: git→snapshot-Cutover (atomar)

**Der Kern-Task.** Ein DI-Swap zwingt, alle Consumer gemeinsam zu ändern — sonst bricht der projektweite Typecheck. `GitPort`/`CommitPlan`/`git-plan.ts`/`git-port.ts` bleiben als **toter Code** stehen (Task 6 löscht sie); nur die Verdrahtung wird umgehängt. Am Ende: voller `npm run gate` grün, kein Lauf ruft mehr git.

**Files:**
- Modify: `src/core/types.ts` (RunState/RunResult), `src/core/run-log.ts`, `src/core/orchestrator.ts`, `src/obsidian/recovery.ts`, `src/main.ts`, `src/i18n/strings.ts`
- Test: `tests/core/orchestrator*.test.ts`, `tests/core/run-log.test.ts`, `tests/obsidian/recovery.test.ts`, `tests/**/main*`/undo-Tests, `tests/core/git-plan.test.ts` (temporär tolerieren/anpassen)

**Interfaces:**
- Consumes: `SnapshotStore`, `buildUndoPlan`, `VaultPort.trash` (Tasks 1–2).
- Produces:
  - `RunDeps.snapshot: SnapshotStore` (ersetzt `git: GitPort`); `RunDeps.settings.undoHistoryDepth: number`.
  - `RunResult.undoable: boolean` (ersetzt `commitSha: string | null`).
  - `RunState` ohne `baseSha`/`commitSha`.
  - `RecoveryDeps { vault: VaultPort }` (ohne `git`).

- [ ] **Step 1: `types.ts` anpassen**

`RunState` (types.ts:101-117): `baseSha`- und `commitSha`-Zeile **entfernen**.
`RunResult` (types.ts:118-126): `commitSha: string | null;` → `undoable: boolean;`.

- [ ] **Step 2: `run-log.ts` anpassen**

- `frontmatterLines` (run-log.ts:25): die `if (state.commitSha !== null) lines.push(...)`-Zeile entfernen. Stattdessen nach `status`: `lines.push(\`undoable: ${state.writeRegister.length > 0}\`);`
- `buildRunMd` Footer (run-log.ts:55): ersetze den `Commit: … Undo: git revert …`-Block durch:
```ts
	if (state.writeRegister.length > 0) parts.push('', 'Rückgängig: über das Vault-Crews-Panel (Verlauf → Rückgängig).');
```
- run-log.test.ts entsprechend anpassen: Erwartungen auf `commit:`/`git revert` streichen, `undoable`/Rückgängig-Zeile prüfen.

- [ ] **Step 3: `orchestrator.ts` anpassen**

1. `RunDeps` (orchestrator.ts:25-43): `git: GitPort;` → `snapshot: SnapshotStore;`. In `settings` ergänzen: `undoHistoryDepth: number;`. Import: `GitPort` durch `SnapshotStore` in der `import type { … } from './ports'`-Zeile ersetzen; `buildCommitPlan`-Import entfernen.
2. Preflight: `checkGit()` (orchestrator.ts:167-180) **komplett entfernen** und aus der `preflight()`-Kette (orchestrator.ts:97-105) streichen. `this.state.baseSha = …` entfällt mit. Kette wird: `parseTeamAndAgents ?? checkEndpointAndModel ?? acquireLock ?? openRun`.
3. RunState-Init (orchestrator.ts:73-79): `baseSha: null, commitSha: null,` entfernen.
4. `runActionsTask` (orchestrator.ts:313-336): den `ExecutorContext`-Literal (Zeile 318-324) um den Hook ergänzen:
```ts
			preWrite: async (path) => {
				const existed = await this.deps.vault.exists(path);
				const pre = existed ? await this.deps.vault.read(path) : null;
				await this.deps.snapshot.capture(this.state.runId, this.state.teamId, this.state.startedAt, path, existed, pre);
			},
```
5. `commit()` (orchestrator.ts:340-355) → in `finalize()` umbenennen und Inhalt ersetzen:
```ts
	private async finalize(): Promise<void> {
		await this.releaseLock();
		this.state.status = this.finalStatus();
		this.state.endedAt = this.deps.clock.now();
		await this.persist(); // run.md/state.json final (undoable steht drin)

		const written = this.uniqueWrites();
		if (written.length > 0) {
			const postHashes: Record<string, string> = {};
			for (const p of written) {
				try { postHashes[p] = fnv1a(await this.deps.vault.read(p)); } catch { /* seither entfernt — kein postHash */ }
			}
			try {
				await this.deps.snapshot.finalize(this.state.runId, postHashes, this.deps.settings.undoHistoryDepth);
			} catch (e) {
				// Snapshot-Finalize ist nachgelagert; Wirkung ist im Vault. Protokollieren, nicht crashen.
				this.state.tasks.push(protocolFailure(this.deps.clock.now(), 'io', `Snapshot-Finalize fehlgeschlagen: ${errMsg(e)}`));
				await this.persist();
			}
		}
	}
```
   `run()` (orchestrator.ts:88): `await this.commit();` → `await this.finalize();`.
   Import `fnv1a`: `import { fnv1a } from './collectors';` (oben ergänzen).
6. `result()` (orchestrator.ts:379-390): `commitSha: this.state.commitSha,` → `undoable: this.uniqueWrites().length > 0,`.

- [ ] **Step 4: `orchestrator`-Tests anpassen**

- Überall den git-Mock durch einen SnapshotStore-Mock ersetzen. Minimal-Fake:
```ts
function fakeSnapshot(): SnapshotStore & { manifests: Map<string, SnapshotManifest> } {
	const manifests = new Map<string, SnapshotManifest>();
	const blobs = new Map<string, string>();
	return {
		manifests,
		async capture(runId, teamId, createdAt, path, existedBefore, preContent) {
			const m = manifests.get(runId) ?? { runId, teamId, createdAt, entries: [] };
			if (m.entries.some((e) => e.path === path)) return;
			let blob: string | null = null, preHash: string | null = null;
			if (existedBefore && preContent !== null) { blob = `${m.entries.length}.snapshot`; preHash = fnv1a(preContent); blobs.set(`${runId}/${blob}`, preContent); }
			m.entries.push({ path, existedBefore, preHash, postHash: null, blob });
			manifests.set(runId, m);
		},
		async finalize(runId, postHashes) { const m = manifests.get(runId); if (m) for (const e of m.entries) { const h = postHashes[e.path]; if (h !== undefined) e.postHash = h; } },
		async load(runId) { return manifests.get(runId) ?? null; },
		async readBlob(runId, blob) { return blobs.get(`${runId}/${blob}`) ?? ''; },
		async discard(runId) { manifests.delete(runId); },
		async list() { return [...manifests.keys()]; },
	};
}
```
- Tests, die `checkGit`/`git_refused`/`baseSha`/`commitSha`/nicht-Repo-Verweigerung prüfen, **entfernen oder umschreiben**: der Nicht-Repo-Refused-Fall existiert nicht mehr (ein Lauf ohne git ist jetzt gültig). Ein neuer Test: „nach einem Lauf mit Writes existiert ein finalisierter Snapshot mit postHashes und `result.undoable === true`". Ein Test: „preWrite snapshottet den Pre-Image vor dem Write" (Pre-Image im Fake-Manifest = Zustand vor der Aktion).
- `deps.settings` in allen Test-Fixtures um `undoHistoryDepth: 15` ergänzen; `git`→`snapshot: fakeSnapshot()`.

- [ ] **Step 5: `recovery.ts` anpassen**

- `RecoveryDeps` (recovery.ts:87-90): `git: GitPort;` entfernen → nur `{ vault: VaultPort }`. Import `GitPort`, `buildCommitPlan` entfernen.
- `RecoveryModal.finish()` (recovery.ts:133-156): den git-Teil entfernen. Neu:
```ts
	async finish(): Promise<void> {
		const { vault } = this.deps;
		const { runDir, state } = this.orphan;
		const finished: RunState = { ...state, status: 'aborted', endedAt: state.endedAt ?? Date.now() };
		await vault.modify(`${runDir}/run.md`, buildRunMd(finished));
		await vault.modify(`${runDir}/state.json`, buildStateJson(finished));
		await vault.modify(lockPathFor(runDir), JSON.stringify({ active: false }));
		this.close();
	}
```
  (Der write-ahead-Snapshot des abgestürzten Laufs bleibt liegen und ist über den normalen Undo-Pfad rollbar — postHash=null → ohne Konfliktwarnung.)
- recovery.test.ts: git-Mock/`applyPlan`-Erwartungen entfernen; `RecoveryDeps` ohne `git`.

- [ ] **Step 6: `main.ts` anpassen**

1. Import (main.ts:44): `ChildProcessGitPort` → `AdapterSnapshotStore` aus `./obsidian/snapshot-store`. `GitPort` aus dem `import type … ports`-Statement entfernen, `SnapshotStore`, `SnapshotManifest` ergänzen. `resolveVaultRoot`/`hasBasePath` (main.ts:694-702) werden nicht mehr für git gebraucht — entfernen (falls nichts anderes sie nutzt).
2. Feld (main.ts:91): `private git!: GitPort;` → `private snapshot!: SnapshotStore;`.
3. `initPorts()` (main.ts:169-181): `this.git = new ChildProcessGitPort(resolveVaultRoot(this.app));` → `this.snapshot = new AdapterSnapshotStore(this.app);`.
4. `executeRunFor` deps (main.ts:274-290): `git: this.git,` → `snapshot: this.snapshot,`; in `settings` ergänzen `undoHistoryDepth: this.settings.undoHistoryDepth,`.
5. `LastRunInfo` (main.ts:60-70): `commitSha: string | null;` → `undoable: boolean;`.
6. `onRunFinished` (main.ts:320-332): `commitSha: result.commitSha,` → `undoable: result.undoable,`.
7. `getLastRunSummary`/`RunSummary`: falls `commitSha` genutzt (main.ts:393), auf `undoable` umstellen (siehe Panel-Anpassung unten).
8. `startUndo()` (main.ts:547-572) neu:
```ts
	private async startUndo(): Promise<void> {
		const recent = this.mostRecentRun();
		if (recent === null || !recent.info.undoable) { new Notice(t('notice.run.noLastRun')); return; }
		const runId = recent.info.runId;
		const manifest = await this.snapshot.load(runId);
		if (manifest === null || manifest.entries.length === 0) { new Notice(t('notice.run.noLastRun')); return; }

		const currentContents: Record<string, string | null> = {};
		const blobs: Record<string, string> = {};
		for (const e of manifest.entries) {
			currentContents[e.path] = (await this.vault.exists(e.path)) ? await this.vault.read(e.path) : null;
			if (e.blob !== null) blobs[e.blob] = await this.snapshot.readBlob(runId, e.blob);
		}
		const plan = buildUndoPlan(manifest, currentContents, blobs);
		const files = manifest.entries.map((e) => e.path);
		const lines = [
			`${t('undo.field.team')}: ${this.teamName(recent.teamId)}`,
			`${t('undo.field.time')}: ${new Date(recent.info.when).toLocaleString()}`,
			`${t('undo.field.files')}: ${files.length > 0 ? files.join(', ') : '—'}`,
		];
		lines.push(t('undo.warnDiscard'));
		if (plan.conflicts.length > 0) lines.push(t('undo.warnConflict', plan.conflicts.length));
		new ConfirmModal(this.app, {
			title: t('undo.title'),
			lines,
			confirmLabel: t('undo.confirmButton'),
			onConfirm: () => this.performUndo(runId, recent.teamId, plan),
		}).open();
	}
```
9. `performUndo()` (main.ts:577-595) neu (Signatur ändert sich):
```ts
	private async performUndo(runId: string, teamId: string, plan: UndoPlan): Promise<void> {
		try {
			for (const r of plan.restores) {
				if (await this.vault.exists(r.path)) await this.vault.modify(r.path, r.content);
				else await this.vault.create(r.path, r.content);
			}
			for (const p of plan.deletes) {
				if (await this.vault.exists(p)) await this.vault.trash(p);
			}
		} catch {
			new Notice(t('notice.undo.failed'));
			return;
		}
		await this.snapshot.discard(runId);
		const info = this.lastRuns[teamId];
		if (info !== undefined) { info.undoable = false; void this.saveSettings(); }
		await this.markRunUndone(runId);
		new Notice(t('notice.undo.ok', plan.restores.length + plan.deletes.length));
	}

	/** run.md des rückgängig gemachten Laufs mit einem Hinweis versehen (best effort). */
	private async markRunUndone(runId: string): Promise<void> {
		const path = `${this.settings.crewRoot}/runs/${runId}/run.md`;
		try {
			if (await this.vault.exists(path)) {
				const cur = await this.vault.read(path);
				if (!cur.includes(t('undo.logMarker'))) await this.vault.modify(path, `${cur}\n${t('undo.logMarker')}\n`);
			}
		} catch { /* best effort */ }
	}
```
10. `readRunState` (main.ts:597-611): wird von `startUndo` nicht mehr gebraucht (Pfade kommen aus dem Manifest) → entfernen, sofern kein anderer Aufrufer bleibt.
11. `checkRecovery` (main.ts:484-489): `{ vault: this.vault, git: this.git }` → `{ vault: this.vault }`.
12. `isValidLastRunInfo`/`filterValidLastRuns` (main.ts:730-746): `commitSha`-Prüfung → `undoable`. **Migration:** akzeptiere Alt-Einträge und leite `undoable` ab:
```ts
function isValidLastRunInfo(v: unknown): v is LastRunInfo {
	return (
		isRecord(v) && typeof v.when === 'number' && Number.isFinite(v.when)
		&& typeof v.status === 'string' && typeof v.runId === 'string'
	);
}
function filterValidLastRuns(raw: Record<string, unknown>): LastRuns {
	const out: LastRuns = {};
	for (const [teamId, info] of Object.entries(raw)) {
		if (isValidLastRunInfo(info)) {
			const rec = info as unknown as Record<string, unknown>;
			// Migration: Alt-Feld commitSha → undoable
			const undoable = typeof rec.undoable === 'boolean' ? rec.undoable : (typeof rec.commitSha === 'string' && rec.commitSha !== null);
			out[teamId] = { ...(info as LastRunInfo), undoable };
		}
	}
	return out;
}
```
13. Panel-Kopplung: prüfe `src/obsidian/panel.ts`/`panel-view-model.ts` + `RunSummary` (main.ts export) auf `commitSha`. Wo `commitSha` das Undo-Angebot gated, auf `undoable` umstellen. Undo-Button nur zeigen/aktiv, wenn der jüngste Lauf `undoable` ist. `RunSummary.commitSha` → entfernen oder `undoable` (Panel-Text braucht keine SHA mehr).

- [ ] **Step 7: i18n anpassen** (`src/i18n/strings.ts`, EN + DE)

- `undo.field.commit` **entfernen** (beide Sprachen).
- Neu (EN):
```ts
	"undo.warnConflict": "{0} file(s) were changed after the run — roll back anyway?",
	"undo.logMarker": "> [!warning] This run was undone.",
	"notice.undo.failed": "Undo failed — no changes were made.",
```
  (DE):
```ts
	"undo.warnConflict": "{0} Datei(en) wurden nach dem Lauf geändert — trotzdem zurückrollen?",
	"undo.logMarker": "> [!warning] Dieser Lauf wurde rückgängig gemacht.",
	"notice.undo.failed": "Rückgängig fehlgeschlagen — nichts geändert.",
```
- `notice.undo.ok` (beide) umformulieren, Platzhalter = Datei-Zahl statt SHA:
  EN: `"notice.undo.ok": "Undo complete — restored {0} file(s) to the state before the run.",`
  DE: `"notice.undo.ok": "Rückgängig gemacht — {0} Datei(en) auf den Stand vor dem Lauf zurückgesetzt.",`
- `notice.undo.conflict`/`restoreOffer`/`restored` werden nicht mehr referenziert (git-Konfliktpfad entfällt) → entfernen, sofern kein Consumer bleibt (grep!).
- `recovery.finish` (beide): git-Wort raus, sinngemäß „Verwaisten Lauf abschließen" / „Finish orphaned run".

- [ ] **Step 8: `git-plan.test.ts` temporär behandeln**

`tests/core/git-plan.test.ts` testet noch `buildCommitPlan`. Da `git-plan.ts` bis Task 6 steht, bleibt der Test grün — **nicht anfassen**. (Task 6 löscht beides.)

- [ ] **Step 9: Voller Gate + Iteration bis grün**

Run: `npm run gate`
Erwartete Reibungspunkte + Fix-Reihenfolge:
1. Typecheck: verbleibende `commitSha`/`baseSha`/`git`-Referenzen (main/panel/recovery/tests) — der Compiler zeigt jede Stelle. Alle auf `undoable`/`snapshot` umstellen.
2. `check:pure`: `undo-plan.ts` darf `obsidian` nicht importieren (nur `collectors`+`ports` — ok).
3. Tests: orchestrator/recovery/main-Suites nach obiger Anleitung.
Solange iterieren, bis `npm run gate` Exit 0 liefert.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(undo)!: git→snapshot-Cutover — Undo ohne child_process/fs

RunDeps.git→snapshot, checkGit-Preflight entfällt (keine git-Repo-Pflicht),
commit()→finalize() schreibt Snapshot-Manifest statt git-Commit; RunState.
baseSha/commitSha → RunResult.undoable. Undo in main.ts über buildUndoPlan +
SnapshotStore + VaultPort.trash; fnv1a-Konfliktwarnung. Recovery ohne git.
i18n von git/commit/revert entkoppelt. GitPort/git-plan bleiben vorerst
toter Code (Task 6 löscht).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Settings-Knopf „Undo-Verlauf-Tiefe"

Macht die Retention konfigurierbar (default 15). Der Orchestrator liest bereits `deps.settings.undoHistoryDepth` (Task 4) — hier kommt der echte Wert + UI dazu.

**Files:**
- Modify: `src/obsidian/settings.ts` (`PluginSettings`, `DEFAULT_SETTINGS`, `SettingsTab`)
- Test: `tests/obsidian/settings.test.ts` (falls vorhanden) bzw. mergeSettings-Test

- [ ] **Step 1: Fehlschlagenden Test** (falls eine settings/mergeSettings-Testdatei existiert; sonst diesen Schritt in den Gate-Lauf falten)

```ts
it('undoHistoryDepth hat Default 15 und wird aus data.json übernommen', () => {
	expect(mergeSettings(DEFAULT_SETTINGS, null).undoHistoryDepth).toBe(15);
	expect(mergeSettings(DEFAULT_SETTINGS, { undoHistoryDepth: 5 }).undoHistoryDepth).toBe(5);
});
```

- [ ] **Step 2: `PluginSettings` + `DEFAULT_SETTINGS`** (`src/obsidian/settings.ts`)

Feld `undoHistoryDepth: number;` in `PluginSettings`; `undoHistoryDepth: 15,` in `DEFAULT_SETTINGS`.

- [ ] **Step 3: UI-Zeile im `SettingsTab`** (Obsidian-nativ, `../UI-STANDARD.md`)

```ts
new Setting(containerEl)
	.setName(t('settings.undoDepth.name'))
	.setDesc(t('settings.undoDepth.desc'))
	.addText((tx) => tx
		.setValue(String(this.host.settings.undoHistoryDepth))
		.onChange(async (v) => {
			const n = Number.parseInt(v, 10);
			if (Number.isFinite(n) && n >= 1 && n <= 100) { this.host.settings.undoHistoryDepth = n; await this.host.saveSettings(); }
		}));
```
i18n-Keys `settings.undoDepth.name`/`.desc` (EN+DE) ergänzen.

- [ ] **Step 4: Gate + Commit**

```bash
npm run gate
git add src/obsidian/settings.ts src/i18n/strings.ts tests/
git commit -m "$(cat <<'EOF'
feat(undo): Settings-Knopf Undo-Verlauf-Tiefe (default 15)

undoHistoryDepth steuert die Snapshot-Retention (prune bei finalize).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Toten git-Code löschen + Verifikation

Jetzt referenziert nichts mehr git → sicher entfernbar. Deliverable: `grep` bestätigt null git-Reste.

**Files:**
- Delete: `src/obsidian/git-port.ts`, `src/core/git-plan.ts`, `tests/**/git-port*.test.ts`, `tests/core/git-plan.test.ts`
- Modify: `src/core/ports.ts` (`GitPort`/`GitStatusInfo`/`CommitPlan` entfernen)

- [ ] **Step 1: Dateien löschen**

```bash
git rm src/obsidian/git-port.ts src/core/git-plan.ts tests/core/git-plan.test.ts
# git-port-Test finden + entfernen, falls vorhanden:
git ls-files 'tests/**/*git*' | xargs -r git rm
```

- [ ] **Step 2: Verträge aus `ports.ts` entfernen**

`GitStatusInfo` (ports.ts:59-65), `CommitPlan` (ports.ts:66) und `GitPort` (ports.ts:67-72) löschen.

- [ ] **Step 3: Verifikation — kein git mehr**

Run:
```bash
grep -rEn "child_process|node:fs|GitPort|CommitPlan|git revert|applyPlan|buildCommitPlan|ChildProcessGitPort" src/ tests/
```
Expected: **keine Treffer** (Exit 1 / leere Ausgabe).

- [ ] **Step 4: Gate + Commit**

```bash
npm run gate
git add -A
git commit -m "$(cat <<'EOF'
refactor(undo): toten git-Code entfernen (git-port, git-plan, GitPort)

Kein child_process/node:fs mehr im gesamten Plugin — die zwei Store-Review-
Behavior-Warnings sind damit strukturell weg.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Version-Bump 0.2.0 + Docs

**Files:**
- Modify: `manifest.json`, `package.json`, `CHANGELOG.md`, `AGENTS.md` (Smoke-Checkliste + git-Gotchas), `README.md`/`README.de.md` (V1-limitations/Undo-Abschnitt)

- [ ] **Step 1: Versionen**

`manifest.json` `"version": "0.1.0"` → `"0.2.0"`; `package.json` ebenso. (`versions.json` falls vorhanden: `"0.2.0": "1.8.7"` ergänzen.)

- [ ] **Step 2: CHANGELOG-Eintrag `## [0.2.0]`**

Inhalt: „git-freies Snapshot-Undo über die Vault-/Adapter-API; funktioniert in jedem Vault (keine git-Repo-Pflicht mehr); entfernt die `child_process`/`fs`-Store-Warnings; erzeugte Notes gehen bei Undo in den Papierkorb; Konfliktwarnung bei seit dem Lauf editierten Notes; Retention über neue Einstellung `Undo-Verlauf-Tiefe`."

- [ ] **Step 3: `AGENTS.md` Smoke-Checkliste anpassen**

- §Smoke Punkt 5/6: `git log`/`git revert`/„genau ein `crew(...)`-Commit" streichen → „Undo über Panel (Verlauf → Rückgängig): geänderte Notes wieder im Vorzustand, erzeugte Notes im Papierkorb; Snapshot-Ordner `.obsidian/plugins/vault-crews/undo/<runId>/` verschwindet nach Undo."
- Der Klon muss **kein git-Repo** mehr sein — Hinweis in §Smoke/clone-vault.sh-Kontext anpassen.
- §Architecture notes: den git/`checkGit`-Absatz durch den Snapshot-Store-Mechanismus ersetzen (write-ahead, Adapter-Pfad, `preWrite`-Hook, Papierkorb-Undo).

- [ ] **Step 4: README (EN + DE) — Undo/limitations**

Undo-Beschreibung von „git revert" auf Snapshot umstellen; die frühere git-Repo-Voraussetzung + der zugehörige V1-limitations-Punkt entfallen. Store-Warnings-Abschnitt (falls vorhanden) aktualisieren: child_process/fs nicht mehr vorhanden.

- [ ] **Step 5: Gate + Commit**

```bash
npm run gate
git add -A
git commit -m "$(cat <<'EOF'
chore(release): 0.2.0 — Snapshot-Undo, Docs + Smoke-Checkliste

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manueller Abschluss (nach Task 7, durch Johannes/Smoke)

- **Smoke-Test** gegen einen Wegwerf-Klon (jetzt ohne git): beide Beispiel-Crews laufen lassen, Undo testen (restore + Papierkorb + Konfliktwarnung bei manueller Zwischen-Edit), Recovery (Obsidian mitten im Lauf killen) — Partial bleibt, ist undo-bar.
- **Merge** `feat/snapshot-undo` → `main` (`--no-ff`).
- **Release** `npm run release -- 0.2.0` (Codeberg + GitHub-Mirror), danach erneute Store-Einreichung (Account-Aktion Johannes).

---

## Self-Review-Notiz (Plan gegen Spec)

- Spec §2.1 Copy-on-Write → Task 3 (Hook) + Task 4 Step 3.4 (Orchestrator-Verdrahtung). ✔
- Spec §3 Storage-Layout → Task 2 (AdapterSnapshotStore). ✔
- Spec §4 Datenmodell + buildUndoPlan → Task 1. ✔
- Spec §4.1 undoable-Migration → Task 4 Step 1/6 (isValidLastRunInfo). ✔
- Spec §5 Orchestrator (checkGit raus, finalize) → Task 4 Step 3. ✔
- Spec §6 Executor-Hook → Task 3. ✔
- Spec §7 Recovery ohne git → Task 4 Step 5. ✔
- Spec §8 Undo-Ausführung + trash → Task 1 (trash-Vertrag), 2 (Impl), 4 Step 6 (startUndo/performUndo). ✔
- Spec §9 Retention + Settings → Task 2 (prune) + Task 5 (Knopf). ✔
- Spec §10 run.md/i18n → Task 4 Step 2/7. ✔
- Spec §11 Löschungen → Task 6. ✔
- Spec §12 Tests + check:pure → jeder Task. ✔
- Spec §13 Version → Task 7. ✔
