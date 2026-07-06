// Crash-Recovery (Spec §5.3/§7): beim nächsten Plugin-Load erkennt PREFLIGHT eine
// verwaiste Lock-Datei + `state.json status: 'running'` → Recovery-Dialog mit genau
// EINER empfohlenen Handlung. Lock-/State-Format ist exakt das des Orchestrators
// (src/core/orchestrator.ts, private Helfer `lockPath`/`lockContent`/`isLockHeld`/
// `releaseLock`/`persist`) — hier nachgebildet, nicht neu erfunden:
//   aktiv:    `{"active": true, "runId": "<id>", "startedAt": <ms>}`  (acquireLock)
//   released: `{"active": false}`                                    (releaseLock;
//     die Lock-Datei wird nie gelöscht, nur überschrieben — releaseLock modifiziert
//     sie nur, wenn sie existiert)
// Ein Crash mitten im Lauf lässt die Lock-Datei im "active"-Zustand UND
// `runs/<runId>/state.json` mit `status: "running"` zurück, weil der Orchestrator den
// finalen Status erst in `finalize()` setzt — NACH `releaseLock()` (siehe `run()`:
// `taskLoop()` → `finalize()` = `releaseLock()` → `finalStatus()` → `persist()`).
// Beide Bedingungen müssen daher gemeinsam zutreffen: ein aktives Lock mit bereits
// abgeschlossenem state.json wäre nur ein schlecht getimter Read (kein Crash), und
// "running" mit released Lock kann laut dieser Schreibreihenfolge nicht vorkommen.
import { Modal, type App } from "obsidian";
import type { VaultPort } from "../core/ports";
import type { RunState } from "../core/types";
import { buildRunMd, buildStateJson } from "../core/run-log";
import { t } from "../vendor/kit/i18n";

export interface OrphanedRun {
  runId: string;
  runDir: string;
  state: RunState;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lock-Pfad aus dem runDir zurückgewinnen: runDir = `<crewRoot>/runs/<runId>`.
 *  Non-dotfile (`run-lock.json`, nicht `.lock`) — Obsidians TFile-Index indiziert
 *  keine Dotfiles, `vault.read`/`vault.modify` (beide gehen über getAbstractFileByPath)
 *  würden für eine `.lock`-Datei zur Laufzeit werfen (siehe orchestrator.ts lockPath). */
function lockPathFor(runDir: string): string {
  const parts = runDir.split("/");
  parts.pop(); // runId
  return `${parts.join("/")}/run-lock.json`;
}

/**
 * Prüft `<crewRoot>/runs/run-lock.json` + das referenzierte `state.json` auf einen
 * verwaisten (Crash-)Lauf. Liefert `null` bei fehlender/kaputter Lock-Datei
 * (korrupt → wie der Orchestrator selbst: stiller Übernahme-Fall, kein Recovery-
 * Dialog), released Lock, oder einem `state.json`, das den Lauf bereits regulär
 * abgeschlossen zeigt.
 *
 * Annahme + bekannte Grenze: das wird beim Plugin-`onload` aufgerufen, also lange
 * NACHDEM der Prozess, der einen etwaigen vorherigen Lauf ausgeführt hat, beendet
 * ist (Obsidian neu gestartet/geöffnet). Ein aktives Lock + `state.json.status ===
 * 'running'` heißt zu diesem Zeitpunkt daher zuverlässig "auf DIESEM Gerät
 * abgestürzt" — es gibt keinen laufenden Prozess mehr, der das Lock noch halten
 * könnte, und keinen Clock-Vergleich nötig (bewusst kein Timeout-Parameter hier,
 * anders als `orchestrator.isLockHeld`, das GEGEN einen aktiven Fremdlauf im selben
 * Prozessraum prüft). Der eine False-Positive-Fall — ein über Cloud-Sync geteilter
 * Vault, auf zwei Desktops gleichzeitig geöffnet, während dort ein Lauf aktiv ist —
 * ist laut Spec §10 Risiko 8 ("Ein-Lauf-Lock") explizit außerhalb des V1-Scopes und
 * hier ungefährlich: die Recovery-Handlung ist ein vom Nutzer bestätigter
 * Modal-Klick, nie automatisch, also committet nichts von selbst.
 */
export async function checkOrphanedRun(vault: VaultPort, crewRoot: string): Promise<OrphanedRun | null> {
  const lockPath = `${crewRoot}/runs/run-lock.json`;
  let lock: unknown;
  try {
    if (!(await vault.exists(lockPath))) return null;
    lock = JSON.parse(await vault.read(lockPath));
  } catch {
    return null;
  }
  if (!isRecord(lock) || lock.active === false || typeof lock.runId !== "string") return null;

  const runId = lock.runId;
  const runDir = `${crewRoot}/runs/${runId}`;
  let state: unknown;
  try {
    state = JSON.parse(await vault.read(`${runDir}/state.json`));
  } catch {
    return null;
  }
  if (!isRecord(state) || state.status !== "running") return null;
  return { runId, runDir, state: state as unknown as RunState };
}

export interface RecoveryDeps {
  vault: VaultPort;
}

/**
 * Zeigt den verwaisten Lauf und genau EINE empfohlene Handlung: „Verwaisten Lauf
 * abschließen". Deps (vault) sind injiziert — kein Zugriff auf ein Plugin-Singleton
 * (main.ts konstruiert diese Klasse selbst). Kein git mehr: die Partial-Writes des
 * abgestürzten Laufs liegen im Vault, ihr write-ahead-Snapshot ebenfalls → der Lauf
 * ist über den normalen Undo-Pfad rollbar (postHash=null → ohne Konfliktwarnung).
 */
export class RecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly orphan: OrphanedRun,
    private readonly deps: RecoveryDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("recovery.title") });
    contentEl.createEl("p", { text: t("recovery.explain", this.orphan.state.teamId) });

    const finishBtn = contentEl.createEl("button", { cls: "mod-cta", text: t("recovery.finish") });
    // `void`: no-floating-promises-konformes Fire-and-forget — addEventListener
    // erwartet einen void-zurückgebenden Listener (dieselbe Konvention, aus der
    // gleichen Erwägung, wie in panel.ts, nur dass finish() hier tatsächlich async ist).
    finishBtn.addEventListener("click", () => { void this.finish(); });
  }

  /** Schließt den verwaisten Lauf ab: run.md/state.json auf 'aborted' schreiben und
   *  das Lock freigeben. Public (statt private), damit main.ts (und diese Tests) den
   *  Effekt direkt auslösen können, ohne eine simulierte DOM-Klick-Zeremonie.
   *
   *  Kein Commit: das Snapshot-Netz (write-ahead beim Applizieren) macht git in der
   *  Recovery überflüssig. Die Partial-Writes des abgestürzten Laufs liegen bereits im
   *  Vault, ihr Pre-Image-Snapshot ebenfalls — der Lauf ist über den normalen Undo-Pfad
   *  rollbar (mit postHash=null, also ohne Konfliktwarnung). Wichtig bleibt nur, dass
   *  BEIDE — run.md UND state.json — den finalen 'aborted'-Status tragen; sonst hinge
   *  state.json für immer auf "running".
   */
  async finish(): Promise<void> {
    const { vault } = this.deps;
    const { runDir, state } = this.orphan;

    const finished: RunState = { ...state, status: "aborted", endedAt: state.endedAt ?? Date.now() };

    // Log final schreiben (Status aborted) + Lock freigeben. Kein Commit — die bereits
    // im Vault liegenden Partial-Writes bleiben stehen und sind über den Snapshot undo-bar.
    await vault.modify(`${runDir}/run.md`, buildRunMd(finished));
    await vault.modify(`${runDir}/state.json`, buildStateJson(finished));
    await vault.modify(lockPathFor(runDir), JSON.stringify({ active: false }));

    this.close();
  }
}
