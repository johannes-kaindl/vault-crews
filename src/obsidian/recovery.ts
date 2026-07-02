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
// finalen Status erst in `commit()` setzt — NACH `releaseLock()` (siehe `run()`:
// `taskLoop()` → `commit()` = `releaseLock()` → `finalStatus()` → `persist()`).
// Beide Bedingungen müssen daher gemeinsam zutreffen: ein aktives Lock mit bereits
// abgeschlossenem state.json wäre nur ein schlecht getimter Read (kein Crash), und
// "running" mit released Lock kann laut dieser Schreibreihenfolge nicht vorkommen.
import { Modal, type App } from "obsidian";
import type { GitPort, VaultPort } from "../core/ports";
import type { RunState } from "../core/types";
import { buildCommitPlan } from "../core/git-plan";
import { buildRunMd } from "../core/run-log";
import { t } from "../vendor/kit/i18n";

export interface OrphanedRun {
  runId: string;
  runDir: string;
  state: RunState;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lock-Pfad aus dem runDir zurückgewinnen: runDir = `<crewRoot>/runs/<runId>`. */
function lockPathFor(runDir: string): string {
  const parts = runDir.split("/");
  parts.pop(); // runId
  return `${parts.join("/")}/.lock`;
}

/**
 * Prüft `<crewRoot>/runs/.lock` + das referenzierte `state.json` auf einen
 * verwaisten (Crash-)Lauf. Liefert `null` bei fehlender/kaputter Lock-Datei
 * (korrupt → wie der Orchestrator selbst: stiller Übernahme-Fall, kein Recovery-
 * Dialog), released Lock, oder einem `state.json`, das den Lauf bereits regulär
 * abgeschlossen zeigt.
 */
export async function checkOrphanedRun(vault: VaultPort, crewRoot: string): Promise<OrphanedRun | null> {
  const lockPath = `${crewRoot}/runs/.lock`;
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
  git: GitPort;
}

/**
 * Zeigt den verwaisten Lauf und genau EINE empfohlene Handlung: „Verwaisten Lauf
 * abschließen (Teilstand committen)". Deps (vault/git) sind injiziert — kein Zugriff
 * auf ein Plugin-Singleton (main.ts, nächster Task, konstruiert diese Klasse selbst).
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

  /** Committet den Teilstand, schreibt run.md als `aborted` mit der Commit-SHA um,
   *  und gibt das Lock frei — exakt der in Spec §5.3 beschriebene Recovery-Pfad.
   *  Public (statt private), damit main.ts (und diese Tests) den Effekt direkt
   *  auslösen können, ohne über eine simulierte DOM-Klick-Zeremonie zu müssen. */
  async finish(): Promise<void> {
    const { vault, git } = this.deps;
    const { runDir, state } = this.orphan;

    const finished: RunState = { ...state, status: "aborted", endedAt: state.endedAt ?? Date.now() };
    const plan = buildCommitPlan(finished, runDir);
    const commitSha = await git.applyPlan(plan);
    finished.commitSha = commitSha;

    await vault.modify(`${runDir}/run.md`, buildRunMd(finished));
    await vault.modify(lockPathFor(runDir), JSON.stringify({ active: false }));

    this.close();
  }
}
