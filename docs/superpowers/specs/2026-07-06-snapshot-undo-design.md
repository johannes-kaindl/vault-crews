# Design-Spec: Snapshot-/Quarantäne-Undo (0.2.0)

> Abgeleitet aus dem Design-Brief `2026-07-06-snapshot-undo-design-brief.md` nach
> Brainstorming-Dialog. Ersetzt das git-gekoppelte Undo durch ein plugin-eigenes
> Snapshot-Undo über die Obsidian-Vault-/Adapter-API. **Harte Randbedingung:** kein
> `child_process`, kein `node:fs` — jede Lösung, die das wieder einführt, verfehlt das Ziel.

## 1. Ziel & Motivation

Das aktuelle Sicherheitsnetz setzt voraus, dass der Vault ein **git-Repo** ist: Run-Logs
werden per System-`git` (`child_process`) committet, Undo ist `git revert`. Drei Treiber
lösen das ab:

1. **Voller Store-Pass.** `child_process` (Shell Execution) + node-`fs` (Direct Filesystem
   Access) sind die zwei „Behavior"-Warnings, die einen grünen Community-Review-Report
   verhindern. Ohne git fallen beide weg.
2. **Funktioniert für ALLE User.** Die meisten Vaults sind kein git-Repo → das heutige Netz
   greift für die Mehrheit gar nicht. Der `git_refused`-Preflight, der Nicht-Repos den Lauf
   verweigert, entfällt ersatzlos.
3. **Besser gescoped, weniger fragil.** `git revert` eines Run-Commits kann parallele
   Fremdänderungen mitreißen; die dokumentierte Dirty-Working-Tree-Fragilitätsklasse
   (revert/rebase muss stash-wrappen) verschwindet komplett.

### Scope-Korrektur gegenüber dem Brief
Der Brief nennt „bündelt uncommittete 0.1.x-Fixes (manifest-Punkt, minAppVersion 1.8.7,
`getLanguage()`, `js-yaml`→`yaml`)". Diese sind laut git-Log **bereits committet** (`181dac2`)
und im Repo aktiv (manifest `minAppVersion: 1.8.7`, dep `yaml ^2.5.0`, kein `js-yaml`).
**0.2.0 ist daher rein der Snapshot-Undo-Umbau** plus Versions-Bump.

## 2. Kernmechanik

Das Aktions-Set ist **löschungsfrei**: `frontmatter.patch`, `note.create`, `note.append`,
`section.replace`. Undo ist damit mechanisch trivial und pro betroffenem Pfad genau eine von
zwei Operationen:

- **Note existierte vor dem Lauf** und wurde geändert → Pre-Image aus dem Snapshot
  zurückschreiben (`vault.modify`, bzw. `create`, falls sie zwischenzeitlich verschwand).
- **Note wurde vom Lauf erzeugt** (existierte vorher nicht) → in den **Obsidian-Papierkorb**
  verschieben (`fileManager.trashFile`), **nie** hart löschen — der User kann sie wiederholen.

Kein Wiederauferstehen gelöschter Dateien nötig — das Aktions-Set löscht nie.

### 2.1 Copy-on-Write, write-ahead

Der Snapshot des Pre-Image entsteht **unmittelbar vor dem ersten Write auf einen Pfad**, in
**Phase 2 des ActionExecutors**. Das ist die einzig korrekte Naht:

- **Korrektheits-Fund:** Der Executor remappt nur Frontmatter-*Werte* (`mappedSet`), **nicht
  Pfade**. `v.path = normalizeVaultPath(action.path)` ist byte-genau der Pfad, der in
  `state.writeRegister` landet. Der Snapshot am `v.path` greift also exakt das, was geändert
  wird.
- **First-write-wins pro Lauf:** Wird derselbe Pfad in zwei Tasks berührt (create in Task A,
  append in Task B), muss der Pre-Image der Zustand **vor Task A** sein. Der SnapshotStore
  ignoriert eine zweite `capture()` desselben Pfads im selben Lauf.
- **Write-ahead = crash-sicher:** Blob + Manifest-Eintrag liegen **auf Platte, bevor** der
  Vault-Write ausgeführt wird. Ein Crash mitten im Lauf lässt damit einen vollständig
  undo-baren Zustand zurück (siehe §7 Recovery). Ein Pfad, der gesnapshottet, aber wegen
  Crash nicht mehr geschrieben wurde, wird beim Undo auf seinen identischen Pre-Image
  „zurückgesetzt" — ein harmloser No-op.

### 2.2 Adapter-Fund (warum ein neuer Port nötig ist)

`ObsidianVaultPort.read/modify/create/append` laufen über `getAbstractFileByPath` (den
TFile-Index) und **werfen für Pfade unter `.obsidian/`** — der Config-Ordner ist nicht
indiziert. Nur `exists/mkdir` gehen bereits über `app.vault.adapter`. Der Snapshot-Store
liegt versteckt unter `.obsidian/plugins/vault-crews/undo/` → er braucht **adapter-level
I/O** (`adapter.read/write/exists/mkdir/list/rmdir/remove`). Das ist ein eigener Port,
kein VaultPort-Missbrauch.

## 3. Storage-Layout

```
.obsidian/plugins/vault-crews/undo/<runId>/
  manifest.json           # Index (siehe Schema §4)
  blobs/<n>.snapshot       # Pre-Image je geänderter Existenz-Note; n = Entry-Index (numerisch)
```

- **Versteckt** unter `.obsidian/` → nicht im Graph/Search/Backlinks indiziert, keine
  `.md`-Verschmutzung des Vaults.
- **Numerische Blob-Namen** (`0.snapshot`, `1.snapshot`, …) statt Pfad-abgeleiteter Namen →
  keine Slash-/Sonderzeichen-Escapes. Das Manifest mappt Entry → Blob.
- Erzeugte Notes (`existedBefore: false`) haben **keinen Blob** (nichts wiederherzustellen,
  nur zu löschen).

## 4. Datenmodell (pur, `core/`)

```ts
// core/ports.ts — ersetzt GitPort/GitStatusInfo/CommitPlan
export interface SnapshotEntry {
  path: string;              // Vault-Pfad, den der Lauf berührt hat
  existedBefore: boolean;
  preHash: string | null;    // fnv1a des Pre-Image (null gdw. !existedBefore)
  postHash: string | null;   // fnv1a des Post-Run-Inhalts (bei finalize gesetzt; null nach Crash)
  blob: string | null;       // Blob-Dateiname (null gdw. !existedBefore)
}
export interface SnapshotManifest {
  runId: string;
  teamId: string;
  createdAt: number;
  entries: SnapshotEntry[];
}

export interface SnapshotStore {
  /** Pre-Image erfassen. First-write-wins: no-op, wenn der Pfad im Lauf schon erfasst ist.
   *  Persistiert Blob + Manifest write-ahead auf Platte. */
  capture(runId: string, teamId: string, createdAt: number, path: string,
          existedBefore: boolean, preContent: string | null): Promise<void>;
  /** Post-Run-Hashes je Pfad nachtragen (Konflikt-Erkennung), Retention prunen. */
  finalize(runId: string, postHashes: Record<string, string>): Promise<void>;
  /** Manifest für Undo laden (null, wenn kein Snapshot existiert). */
  load(runId: string): Promise<SnapshotManifest | null>;
  /** Pre-Image eines Blobs lesen. */
  readBlob(runId: string, blob: string): Promise<string>;
  /** Snapshot eines Laufs verwerfen (nach Undo oder Prune). */
  discard(runId: string): Promise<void>;
  /** Alle vorhandenen Snapshot-runIds (für Retention-Prune). */
  list(): Promise<string[]>;
}
```

```ts
// core/undo-plan.ts (neu, pur) — spiegelt den git-plan.ts-Split
export interface UndoPlan {
  restores: { path: string; content: string }[]; // existedBefore=true → Pre-Image zurückschreiben
  deletes: string[];                              // existedBefore=false → in Papierkorb
  conflicts: string[];                            // WARN-OVERLAY: Teilmenge der restore/delete-Pfade,
                                                  // deren aktueller Inhalt ≠ postHash (seit dem Lauf
                                                  // editiert). Blockiert nicht — der Undo wendet nach
                                                  // Bestätigung ALLE restores+deletes an; conflicts
                                                  // treibt nur die Extra-Warnzeile im Modal.
}
/** Rein: Manifest + aktuelle Inhalte je Pfad (null = existiert nicht mehr) → Plan.
 *  Konflikt gdw. postHash!=null && fnv1a(current) !== postHash (seit dem Lauf editiert).
 *  Bei postHash==null (Crash-Lauf) keine Konflikt-Prüfung möglich → nicht als Konflikt zählen. */
export function buildUndoPlan(
  manifest: SnapshotManifest,
  currentContents: Record<string, string | null>,
  blobs: Record<string, string>,   // blob-Name → Pre-Image-Inhalt
): UndoPlan;
```

### 4.1 RunState-Feldänderungen (`core/types.ts`)

- **Entfernt:** `baseSha: string | null`, `commitSha: string | null` (git-Artefakte).
- **`RunResult` / `LastRunInfo`:** `commitSha: string | null` → `undoable: boolean`
  (`true` gdw. `writeRegister.length > 0` und Snapshot finalisiert). Das ist das Gate, ob
  das Panel „Rückgängig" anbietet.
- `data.json`-Migration: Alt-Einträge mit `commitSha` werden beim Laden auf
  `undoable: commitSha !== null` abgebildet (siehe §9).

## 5. Orchestrator-Änderungen (`core/orchestrator.ts`)

1. **Preflight `checkGit()` entfällt komplett.** Keine git-Repo-Pflicht, kein
   index.lock/merge-Rebase-Check, kein `baseSha`. Der Run-Lock (bereits vault-basiert)
   bleibt unverändert. `RunDeps.git: GitPort` → `RunDeps.snapshot: SnapshotStore`.
2. **`runActionsTask`** übergibt einen `preWrite`-Hook in den `ExecutorContext`:
   ```ts
   preWrite: async (path) => {
     const existed = await this.deps.vault.exists(path);
     const pre = existed ? await this.deps.vault.read(path) : null;
     await this.deps.snapshot.capture(runId, teamId, createdAt, path, existed, pre);
   }
   ```
   Der Store macht first-write-wins; der Orchestrator muss nicht selbst Buch führen.
3. **`commit()` → `finalize()`** (Umbenennung + Neuinhalt): Kein `git.applyPlan` mehr.
   - `releaseLock()`, finalen Status setzen, `persist()` (run.md/state.json final).
   - `postHashes` je `writeRegister`-Pfad aus dem aktuellen Vault-Inhalt berechnen,
     `snapshot.finalize(runId, postHashes)` (setzt postHashes + pruned Retention).
   - `state.undoable = uniqueWrites().length > 0`. Kein zweiter Post-Commit-`persist()`
     nötig (es gibt keine SHA nachzutragen).

## 6. ActionExecutor-Änderung (`core/action-executor.ts`)

`ExecutorContext.preWrite?: (path: string) => Promise<void>` (optional → Tests ohne Hook
bleiben gültig). In Phase 2, vor `applyAction(v, ctx, vault)`:

```ts
if (ctx.preWrite) await ctx.preWrite(v.path);
```

Nur für tatsächlich angewandte (nicht rejected/stale/consistency-verworfene) Aktionen — der
Hook sitzt im Apply-Zweig, nicht in der Validierung. Ein `preWrite`-Throw wird wie ein
Write-Fehler behandelt (Aktion `failed`, `taskFailed`), damit ein Snapshot-I/O-Fehler nie zu
einem Write ohne Sicherheitsnetz führt.

## 7. Recovery-Änderung (`obsidian/recovery.ts`)

Der write-ahead-Snapshot macht git in der Recovery überflüssig:

- `RecoveryDeps` verliert `git`, behält `vault`.
- `finish()`: schreibt run.md/state.json mit Status `aborted`, gibt den Lock frei. **Kein
  Commit.** Die Partial-Writes liegen bereits im Vault, ihr write-ahead-Snapshot ebenfalls →
  der Crash-Lauf ist über den normalen Undo-Pfad rückrollbar (mit `postHash: null` → ohne
  Konflikt-Warnung, weil der Post-Run-Zustand nie sauber finalisiert wurde).

Der Modal-Text bleibt sinngemäß („Verwaisten Lauf abschließen"), nur ohne git-Vokabular.

## 8. Undo-Ausführung (`main.ts`)

`startUndo()`/`performUndo()` werden gegen den neuen Mechanismus verdrahtet:

1. Jüngsten Lauf ermitteln (`mostRecentRun()`), Gate: `info.undoable`.
2. `manifest = await snapshot.load(runId)`; wenn `null` → Notice „nichts rückgängig zu machen".
3. Aktuelle Inhalte je Manifest-Pfad via `vault.exists`/`vault.read`; Blobs via
   `snapshot.readBlob`. `plan = buildUndoPlan(manifest, currentContents, blobs)` (pur).
4. Bestätigungs-Modal (Team, Zeit, Datei-Liste). **Bei `plan.conflicts.length > 0`** eine
   zusätzliche Warnzeile „N Datei(en) seit dem Lauf geändert — trotzdem zurückrollen?".
5. Bei Bestätigung anwenden: `restores` → `vault.modify` (bzw. `create`, falls verschwunden);
   `deletes` → `vault.trash`. Danach `snapshot.discard(runId)` + `run.md` als „rückgängig
   gemacht" markieren (Frontmatter/Footer), `lastRuns[teamId].undoable = false`.

### 8.1 VaultPort-Erweiterung

`VaultPort.trash(path: string): Promise<void>` — Obsidian-Impl `app.fileManager.trashFile`
(respektiert die Papierkorb-Einstellung des Users: System-Trash / `.trash` / vault-lokal).

## 9. Retention & Settings

- **Default-Tiefe 15.** Bei `finalize()` `list()` → nach runId (chronologisch sortierbar,
  da runId zeitpräfixiert) sortieren, alle außer den jüngsten N `discard()`en.
- **Settings-Knopf „Undo-Verlauf-Tiefe"** (`undoHistoryDepth`, default 15, Bereich z. B.
  1–100) im Settings-Tab. `mergeSettings`-Default + eine `Setting`-Zeile.
- **data.json-Migration:** `loadSettings()` bildet Alt-`lastRuns[].commitSha` auf
  `undoable: commitSha !== null` ab; `isValidLastRunInfo` akzeptiert beide Formen.

## 10. run.md / i18n

- **run-log.ts:** `commit:`-Frontmatterzeile entfällt; Footer `Commit: <sha> — Undo: git
  revert <sha>` → `Rückgängig: über das Vault-Crews-Panel (Verlauf → Rückgängig).` Bei
  bereits rückgängig gemachtem Lauf ein `undone: true`-Marker.
- **i18n/strings.ts:** `undo.field.commit` entfällt; `notice.undo.ok/conflict/restoreOffer/
  restored` werden von git/commit/revert-Vokabular auf Snapshot-Sprache umgestellt; neue
  Keys für die „seit dem Lauf geändert"-Konflikt-Warnung. EN + DE parallel.

## 11. Zu löschen / zu ersetzen

| Datei | Aktion |
|---|---|
| `src/obsidian/git-port.ts` | **löschen** (ChildProcessGitPort — einzige child_process/node:fs-Quelle) |
| `src/core/git-plan.ts` | **löschen**; `buildCommitPlan` wird nicht mehr gebraucht (Snapshot nutzt Action-Pfade) |
| `tests/**/git-port*.test.ts` | löschen; git-plan-Tests → undo-plan-Tests umbauen |
| `core/ports.ts` | `GitPort`/`GitStatusInfo`/`CommitPlan` raus, `SnapshotStore` + `VaultPort.trash` rein |

Verbleibende git-Referenzen nach dem Umbau: **keine** (Verifikation: `grep -r
'child_process\|node:fs\|GitPort\|git revert' src/` liefert nichts; `check:pure` bleibt grün).

## 12. Teststrategie

- **Neu, pur (node-env):** `undo-plan.test.ts` (restore/delete/conflict-Matrix, postHash=null-
  Crash-Fall), `snapshot-store`-Vertrag gegen einen In-Memory-Adapter-Mock.
- **Umbauen:** `orchestrator`-Tests (git-Mock → SnapshotStore-Mock; kein baseSha/commitSha;
  finalize statt commit), `action-executor`-Tests (preWrite-Hook-Reihenfolge + Fehlerpfad),
  `recovery`-Tests (kein git), `main`/undo-Tests (SnapshotStore + trash).
- **`check:pure`** muss grün bleiben: `undo-plan.ts`/`snapshot`-Manifest-Logik importieren
  **nie** `obsidian`; die Adapter-Impl lebt in `src/obsidian/`.
- **Smoke-Checkliste (AGENTS.md §Smoke) anpassen:** Punkt 5/6 nennen `git log`/`git revert`
  → auf „Undo über Panel, Snapshot-Ordner unter `.obsidian/…/undo/` verschwindet nach Undo"
  umstellen. Der Klon muss **kein git-Repo** mehr sein.

## 13. Versionierung

- `manifest.json` + `package.json`: `0.1.0` → `0.2.0`.
- CHANGELOG-Eintrag: „git-freies Snapshot-Undo; funktioniert in jedem Vault; entfernt
  child_process/fs-Store-Warnings".
- Nach dem Umbau erneut beim Community-Store einreichen (maximal sauberer Report).

## 14. Nicht-Ziele (YAGNI)

- **Kein Redo.** Nach Undo ist der Pre-Image der Live-Zustand; erneutes Anwenden ist
  Aufgabe eines neuen Laufs.
- **Keine permanente Historie im Plugin.** Die `run.md`-Logs sind der dauerhafte Record;
  wer versionierte Historie will, fährt git selbst über den Vault.
- **Keine optionale git-Integration.** Ersatzlos entfernt (keine Doppelwartung).
- **Kein Multi-Device-Snapshot-Sync.** Wie V1 (Spec §10 Risiko 8): Ein-Gerät-Annahme.
