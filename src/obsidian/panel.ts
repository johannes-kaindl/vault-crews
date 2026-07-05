// Run-Panel (Spec §6.2): rechte Sidebar, ItemView — immer gleiches, ruhiges
// Layout mit genau drei Zuständen (idle/running/done). Bewusst von main.ts
// entkoppelt (Task 17-Vertrag): main.ts (nächster Task) implementiert PanelHost
// und ruft `view.handleEvent(e)` für jedes RunEvent des Orchestrators auf; die View
// selbst kennt weder Plugin noch Ports. DOM ausschließlich über createEl/createDiv
// (obsidianmd-Lint) — nie über eine HTML-String-Zuweisung.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t } from "../vendor/kit/i18n";
import type { RunEvent } from "../core/ports";
import type { RunResult, RunStatus } from "../core/types";

export const VIEW_TYPE_CREWS = "vault-crews-panel";

export interface PanelTeam {
  id: string;
  name: string;
  description: string;
  lastRun: { status: RunStatus; when: number } | null;
}

/** Schmaler Vertrag statt eines main.ts-Imports (siehe SettingsHost-Präzedenzfall
 *  in settings.ts). main.ts (nächster Task) übergibt sein Plugin-Objekt, das diese
 *  fünf Mitglieder implementiert; alle Methoden sind bewusst `void` — das Panel
 *  fragt nie zurück (Spec §6.2 „Null Rückfragen während eines Laufs"). */
export interface PanelHost {
  getTeams(): PanelTeam[];
  runCrew(teamId: string): void;
  abortCurrentRun(): void;
  undoLastRun(): void;
  openLog(): void;
}

// Festes Vokabular (Spec §6.2): ⏳ wartet · ▶ läuft · ✓ ok · ✗ fehlgeschlagen ·
// ↷ übersprungen · ⊘ stale. Task-Zeilen des Panels durchlaufen in der Praxis nur
// running→ok/failed/skipped (aus taskStarted/taskFinished); waiting/stale sind Teil
// des vollständigen, dokumentierten Vokabulars (u. a. run.md-Outcome-Zeilen,
// run-log.ts OUTCOME_PREFIX) und hier der Vollständigkeit halber mitgeführt.
type TaskLineStatus = "waiting" | "running" | "ok" | "failed" | "skipped" | "stale";
const TASK_ICON: Record<TaskLineStatus, string> = {
  waiting: "⏳", running: "▶", ok: "✓", failed: "✗", skipped: "↷", stale: "⊘",
};

interface TaskLine { taskId: string; status: TaskLineStatus; }

interface RunningState {
  kind: "running";
  runId: string;
  teamId: string;
  total: number;
  index: number;
  currentTaskId: string | null;
  lines: TaskLine[];
  tokenCount: number;
  thinkCount: number;
  /** Gesetzt, sobald der Nutzer Abbrechen geklickt hat. Der Orchestrator meldet den
   *  Abbruch erst nach Stream-Teardown + Commit (Event-Latenz) — bis dahin würde das
   *  Panel ohne diesen Flag einfrieren und der Klick wirkte folgenlos (Smoke-Fund).
   *  Er persistiert im Zustand, damit die token-getriebenen Re-Renders keinen aktiven
   *  Cancel-Button wiederbeleben. */
  aborting: boolean;
}
interface DoneState { kind: "done"; result: RunResult; }
type PanelState = { kind: "idle" } | RunningState | DoneState;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Next-action-Text (Spec §7 Grundsatz „die eine nächste Handlung"): bei gesetztem
 *  errorKind übernimmt notice.errorKind.<kind> 1:1 denselben Text wie die Notice
 *  (ein Vokabular, zwei Orte) — errorKind ist bei ok/partial immer null (Orchestrator
 *  setzt es nur in failLlm/failTask/abortRun/finishRefused, siehe orchestrator.ts). */
function nextActionText(result: RunResult): string {
  if (result.errorKind !== null) return t(`notice.errorKind.${result.errorKind}`);
  return result.status === "ok" ? t("panel.nextAction.ok") : t("panel.nextAction.partial");
}

function formatRelative(nowMs: number, whenMs: number): string {
  const diffS = Math.max(0, Math.round((nowMs - whenMs) / 1000));
  if (diffS < 60) return t("panel.relative.justNow");
  const diffMin = Math.round(diffS / 60);
  if (diffMin < 60) return t("panel.relative.minutesAgo", diffMin);
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return t("panel.relative.hoursAgo", diffH);
  return t("panel.relative.daysAgo", Math.round(diffH / 24));
}

export class RunPanelView extends ItemView {
  private state: PanelState = { kind: "idle" };
  /** Über den gesamten Lauf akkumulierte, tatsächlich angewendete Schreibziele
   *  (aus actionApplied-Events) — RunResult trägt nur `writes: number` (Spec-Skelett),
   *  die Pfade für die „Dateien als Links" (Spec §6.2) müssen daher separat mitgeführt
   *  werden. Lebt run-scoped (Reset bei runStarted), überlebt den Übergang nach „done". */
  private runWrites: string[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly host: PanelHost) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CREWS; }
  getDisplayText(): string { return t("panel.header.idle"); }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.render();
  }
  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Treibt running/done ausschließlich aus Orchestrator-Events (main.ts, nächster
   *  Task, verdrahtet RunReporter.emit → handleEvent). Jedes Event rendert das Panel
   *  vollständig neu (DOM = reine Funktion des Zustands) — analog zu SettingsTab
   *  .display(), das ebenfalls bei jedem Aufruf containerEl.empty() macht. */
  handleEvent(e: RunEvent): void {
    switch (e.type) {
      case "runStarted":
        this.runWrites = [];
        this.state = {
          kind: "running", runId: e.runId, teamId: e.teamId,
          total: 0, index: 0, currentTaskId: null, lines: [], tokenCount: 0, thinkCount: 0,
          aborting: false,
        };
        break;
      case "taskStarted":
        if (this.state.kind === "running") {
          this.state.total = e.total;
          this.state.index = e.index;
          this.state.currentTaskId = e.taskId;
          this.state.tokenCount = 0;
          this.state.thinkCount = 0;
          const existing = this.state.lines.find((l) => l.taskId === e.taskId);
          if (existing) existing.status = "running";
          else this.state.lines.push({ taskId: e.taskId, status: "running" });
        }
        break;
      case "token":
        if (this.state.kind === "running") {
          if (e.isThink) this.state.thinkCount += 1;
          else this.state.tokenCount += 1;
        }
        break;
      case "taskFinished":
        if (this.state.kind === "running") {
          const line = this.state.lines.find((l) => l.taskId === e.taskId);
          if (line) line.status = e.status;
        }
        break;
      case "actionApplied":
        if (e.outcome.result === "applied" && !this.runWrites.includes(e.outcome.action.path)) {
          this.runWrites.push(e.outcome.action.path);
        }
        break;
      case "runFinished":
        this.state = { kind: "done", result: e.result };
        break;
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    if (this.state.kind === "idle") this.renderIdle(root);
    else if (this.state.kind === "running") this.renderRunning(root, this.state);
    else this.renderDone(root, this.state);
  }

  // ── Idle ─────────────────────────────────────────────────────────────────

  private renderIdle(root: HTMLElement): void {
    root.createEl("h2", { text: t("panel.header.idle") });
    const list = root.createDiv({ cls: "vault-crews-team-list" });
    for (const team of this.host.getTeams()) {
      const row = list.createDiv({ cls: "vault-crews-team-row" });
      row.createDiv({ cls: "vault-crews-team-name", text: team.name });
      row.createDiv({ cls: "vault-crews-team-desc", text: team.description });
      const statusRow = row.createDiv({ cls: "vault-crews-team-status" });
      if (team.lastRun === null) {
        statusRow.createSpan({ text: t("panel.idle.never") });
      } else {
        statusRow.createSpan({ text: t(`panel.status.${team.lastRun.status}`) });
        statusRow.createSpan({ text: formatRelative(Date.now(), team.lastRun.when) });
      }
      const runBtn = row.createEl("button", { text: t("panel.idle.run") });
      runBtn.addEventListener("click", () => { this.host.runCrew(team.id); });
    }
  }

  // ── Running ──────────────────────────────────────────────────────────────

  private renderRunning(root: HTMLElement, s: RunningState): void {
    root.createEl("h2", {
      text: s.currentTaskId === null
        ? t("panel.header.idle")
        : t("panel.header.running", s.index, s.total, s.currentTaskId),
    });

    const list = root.createDiv({ cls: "vault-crews-task-list" });
    for (const line of s.lines) {
      const row = list.createDiv({ cls: "vault-crews-task-row" });
      row.createSpan({ cls: "vault-crews-task-icon", text: TASK_ICON[line.status] });
      row.createSpan({ cls: "vault-crews-task-label", text: `${line.taskId} — ${t(`panel.status.${line.status}`)}` });
    }

    // Token-Strom default eingeklappt auf eine Fortschrittszeile (Spec §6.2).
    root.createDiv({ cls: "vault-crews-progress", text: t("panel.streaming", s.tokenCount) });

    // <think> nur als Zähler, aufklappbar, nie aufgedrängt: natives <details> ohne
    // `open`-Attribut ist genau diese Semantik, ganz ohne eigene Toggle-Logik.
    const think = root.createEl("details", { cls: "vault-crews-think" });
    think.createEl("summary", { text: t("panel.thinking", s.thinkCount) });

    // Genau EIN Cancel-Button. Nach dem Klick sofortige, persistente Quittung: disabled
    // + „Wird abgebrochen …", bis runFinished den done-Zustand bringt. Der Guard verhindert
    // Mehrfach-Abbrüche (der Mock-Klick ignoriert `disabled`, echtes DOM blockt zusätzlich).
    const cancel = root.createEl("button", {
      cls: "mod-warning",
      text: s.aborting ? t("panel.cancelling") : t("panel.cancel"),
    });
    if (s.aborting) {
      cancel.disabled = true;
    } else {
      cancel.addEventListener("click", () => {
        if (this.state.kind !== "running" || this.state.aborting) return;
        this.state.aborting = true;
        this.render();
        this.host.abortCurrentRun();
      });
    }
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  private renderDone(root: HTMLElement, s: DoneState): void {
    const { result } = s;
    root.createEl("h2", { text: t(`panel.status.${result.status}`) });

    root.createDiv({ text: t("panel.done.filesWritten", result.writes) });
    if (this.runWrites.length > 0) {
      const files = root.createDiv({ cls: "vault-crews-files" });
      for (const path of this.runWrites) {
        // `.internal-link` + `href` = Vault-Pfad: Obsidian löst Klicks auf diese
        // Kombination global auf (kein eigener Navigations-Host in PanelHost nötig).
        files.createEl("a", { cls: "internal-link", text: path, attr: { href: path } });
      }
    }
    if (result.commitSha !== null) {
      root.createDiv({ text: t("panel.done.commit", shortSha(result.commitSha)) });
    }
    root.createDiv({ text: t("panel.done.duration", result.durationS) });

    // Genau EIN kontextabhängiger Primärbutton (Spec §6.2): ok → Log öffnen,
    // sonst (partial/failed/aborted/refused — Fehler ist laut) → Fehlerstelle
    // ansehen. Beide rufen `host.openLog()` — der Vertrag hat bewusst keinen
    // eigenen „viewFailure"-Hook; main.ts entscheidet, wohin genau navigiert wird.
    const primary = root.createEl("button", {
      cls: "mod-cta",
      text: result.status === "ok" ? t("panel.openLog") : t("panel.viewFailure"),
    });
    primary.addEventListener("click", () => { this.host.openLog(); });

    const undo = root.createEl("button", { text: t("panel.undo") });
    undo.addEventListener("click", () => { this.host.undoLastRun(); });

    const nextRow = root.createDiv({ cls: "vault-crews-next-action" });
    nextRow.createSpan({ cls: "vault-crews-next-action-label", text: t("panel.nextAction") });
    nextRow.createSpan({ cls: "vault-crews-next-action-text", text: nextActionText(result) });
  }
}
