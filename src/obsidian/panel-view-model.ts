// Pure ViewModel-Schicht des Run-Panels (UI-STANDARD §6): die gesamte
// Entscheidungslogik als `State → ViewModel`, ganz OHNE `obsidian`-Import und ohne
// DOM. Node-testbar ohne Mock. Die View (panel.ts) hält nur den Zustand, ruft
// `reduceRun` je Event und rendert das von `buildPanelViewModel` gelieferte ViewModel
// via createEl — sie trifft selbst keine Entscheidung mehr.
import { t } from "../vendor/kit/i18n";
import type { RunEvent } from "../core/ports";
import type { ErrorKind, RunResult, RunStatus } from "../core/types";

// ── Navigations- und Lauf-Zustand (zwei orthogonale Achsen, §2 der Spec) ──────

export type NavState = "crews" | "verlauf";

// Festes Vokabular (Spec §6.2): ⏳ wartet · ▶ läuft · ✓ ok · ✗ fehlgeschlagen ·
// ↷ übersprungen · ⊘ stale.
export type TaskLineStatus = "waiting" | "running" | "ok" | "failed" | "skipped" | "stale";
const TASK_ICON: Record<TaskLineStatus, string> = {
  waiting: "⏳", running: "▶", ok: "✓", failed: "✗", skipped: "↷", stale: "⊘",
};

export interface TaskLine { taskId: string; status: TaskLineStatus; }

export interface RunningState {
  kind: "running";
  runId: string;
  teamId: string;
  total: number;
  index: number;
  currentTaskId: string | null;
  lines: TaskLine[];
  tokenCount: number;
  thinkCount: number;
  /** Tatsächlich angewendete Schreibziele (actionApplied === "applied"), run-scoped. */
  writes: string[];
  /** Gesetzt, sobald der Nutzer Abbrechen geklickt hat — persistiert im Zustand, damit
   *  token-getriebene Re-Renders keinen aktiven Abbrechen-Button wiederbeleben. */
  aborting: boolean;
}
export interface DoneState {
  kind: "done";
  result: RunResult;
  /** Aus RunningState.writes übernommen — die „Dateien als Links" der Done-Karte. */
  writes: string[];
  /** Aus RunningState.aborting übernommen: Nutzer hat Abbrechen geklickt. Erlaubt der
   *  Karte die ehrliche Unterscheidung „schon fertig, bevor der Abbruch griff". */
  abortRequested: boolean;
}
export type RunState = { kind: "idle" } | RunningState | DoneState;

/** Anzeigefertiges Futter für die persistente Verlauf-Karte (host-geliefert, §6). */
export interface RunSummary {
  teamName: string;
  status: RunStatus;
  runId: string;
  commitSha: string | null;
  when: number;
  writes: number;
  durationS: number;
  errorKind: ErrorKind | null;
}

// ── Reducer: RunState × RunEvent → RunState (pure, kein Seiteneffekt) ──────────

/** Bildet den nächsten Lauf-Zustand. Bewusst nicht-mutierend an den Rändern (neuer
 *  Zustand pro Übergang), damit er isoliert testbar ist; innerhalb eines RunningState
 *  werden Zähler/Zeilen in place fortgeschrieben (dasselbe Objekt lebt über den Lauf). */
export function reduceRun(state: RunState, e: RunEvent): RunState {
  switch (e.type) {
    case "runStarted":
      return {
        kind: "running", runId: e.runId, teamId: e.teamId,
        total: 0, index: 0, currentTaskId: null, lines: [],
        tokenCount: 0, thinkCount: 0, writes: [], aborting: false,
      };
    case "taskStarted":
      if (state.kind === "running") {
        state.total = e.total;
        state.index = e.index;
        state.currentTaskId = e.taskId;
        state.tokenCount = 0;
        state.thinkCount = 0;
        const existing = state.lines.find((l) => l.taskId === e.taskId);
        if (existing) existing.status = "running";
        else state.lines.push({ taskId: e.taskId, status: "running" });
      }
      return state;
    case "token":
      if (state.kind === "running") {
        if (e.isThink) state.thinkCount += 1;
        else state.tokenCount += 1;
      }
      return state;
    case "taskFinished":
      if (state.kind === "running") {
        const line = state.lines.find((l) => l.taskId === e.taskId);
        if (line) line.status = e.status;
      }
      return state;
    case "actionApplied":
      if (state.kind === "running"
        && e.outcome.result === "applied"
        && !state.writes.includes(e.outcome.action.path)) {
        state.writes.push(e.outcome.action.path);
      }
      return state;
    case "runFinished":
      return {
        kind: "done",
        result: e.result,
        writes: state.kind === "running" ? state.writes : [],
        abortRequested: state.kind === "running" ? state.aborting : false,
      };
  }
}

/** Markiert einen laufenden Zustand als „Abbruch angefordert" (Klick auf Abbrechen).
 *  Idempotent: ein zweiter Aufruf ändert nichts (Guard gegen Mehrfach-Abbruch). */
export function markAborting(state: RunState): RunState {
  if (state.kind === "running") state.aborting = true;
  return state;
}

// ── ViewModel: State → deklarative Render-Beschreibung ────────────────────────

export interface TabVM { id: NavState; label: string; active: boolean; }

export interface TeamRowVM {
  id: string;
  name: string;
  description: string;
  statusText: string;
  runLabel: string;
}

export interface SummaryVM {
  /** Bei Verlauf-Karten der Crew-Name, sonst null (Crews-Done kennt seine Crew im Header). */
  teamName: string | null;
  heading: string;
  filesText: string;
  files: string[];
  commitText: string | null;
  durationText: string;
  abortNote: string | null;
  primaryLabel: string;
  undoLabel: string;
  nextActionLabel: string;
  nextActionText: string;
}

export interface CrewHistoryRowVM { teamId: string; text: string; }

export type BodyVM =
  | { kind: "crewsIdle"; empty: boolean; emptyText: string; installLabel: string; teams: TeamRowVM[] }
  | { kind: "crewsRunning"; lines: { icon: string; label: string }[]; streamingText: string; thinkingText: string }
  | { kind: "crewsDone"; summary: SummaryVM; backLabel: string }
  | { kind: "verlauf"; empty: boolean; emptyText: string; latest: SummaryVM | null; crewsHeading: string; crews: CrewHistoryRowVM[] };

export interface StatusLineVM { text: string; abortLabel: string; aborting: boolean; }

export interface PanelViewModel {
  title: string;
  tabs: TabVM[];
  body: BodyVM;
  statusLine: StatusLineVM | null;
}

/** Team-Kopfdaten, wie sie der Host liefert (identisch zu PanelTeam in panel.ts —
 *  hier strukturell dupliziert, um panel.ts nicht zirkulär zu importieren). */
export interface TeamInfo {
  id: string;
  name: string;
  description: string;
  lastRun: { status: RunStatus; when: number } | null;
}

export interface PanelInputs {
  navState: NavState;
  runState: RunState;
  teams: TeamInfo[];
  latest: RunSummary | null;
  nowMs: number;
}

export function buildPanelViewModel(inputs: PanelInputs): PanelViewModel {
  const { navState, runState, teams, latest, nowMs } = inputs;
  return {
    title: t("panel.title"),
    tabs: [
      { id: "crews", label: t("panel.tab.crews"), active: navState === "crews" },
      { id: "verlauf", label: t("panel.tab.verlauf"), active: navState === "verlauf" },
    ],
    body: navState === "verlauf"
      ? buildVerlaufBody(teams, latest, nowMs)
      : buildCrewsBody(runState, teams, nowMs),
    statusLine: runState.kind === "running" ? buildStatusLine(runState) : null,
  };
}

function buildCrewsBody(runState: RunState, teams: TeamInfo[], nowMs: number): BodyVM {
  if (runState.kind === "running") {
    return {
      kind: "crewsRunning",
      lines: runState.lines.map((l) => ({
        icon: TASK_ICON[l.status],
        label: `${l.taskId} — ${t(`panel.status.${l.status}`)}`,
      })),
      streamingText: t("panel.streaming", runState.tokenCount),
      thinkingText: t("panel.thinking", runState.thinkCount),
    };
  }
  if (runState.kind === "done") {
    return {
      kind: "crewsDone",
      summary: summaryFromResult(runState.result, runState.writes, runState.abortRequested),
      backLabel: t("panel.done.back"),
    };
  }
  return {
    kind: "crewsIdle",
    empty: teams.length === 0,
    emptyText: t("panel.idle.empty"),
    installLabel: t("cmd.installExamples"),
    teams: teams.map((tm) => ({
      id: tm.id,
      name: tm.name,
      description: tm.description,
      statusText: tm.lastRun === null
        ? t("panel.idle.never")
        : `${t(`panel.status.${tm.lastRun.status}`)} · ${formatRelative(nowMs, tm.lastRun.when)}`,
      runLabel: t("panel.idle.run"),
    })),
  };
}

function buildVerlaufBody(teams: TeamInfo[], latest: RunSummary | null, nowMs: number): BodyVM {
  const crews: CrewHistoryRowVM[] = teams
    .filter((tm) => tm.lastRun !== null)
    .sort((a, b) => (b.lastRun?.when ?? 0) - (a.lastRun?.when ?? 0))
    .map((tm) => ({
      teamId: tm.id,
      text: t("panel.verlauf.crewRow", tm.name, t(`panel.status.${tm.lastRun!.status}`), formatRelative(nowMs, tm.lastRun!.when)),
    }));
  return {
    kind: "verlauf",
    empty: latest === null,
    emptyText: t("panel.verlauf.empty"),
    latest: latest === null ? null : summaryFromLastRun(latest),
    crewsHeading: t("panel.verlauf.crewsHeading"),
    crews,
  };
}

function buildStatusLine(s: RunningState): StatusLineVM {
  const text = s.aborting
    ? t("panel.statusLine.aborting")
    : s.currentTaskId === null
      ? t("panel.statusLine.starting")
      : t("panel.statusLine.running", s.index, s.total, s.currentTaskId);
  return { text, abortLabel: t("panel.cancel"), aborting: s.aborting };
}

// ── Summary-Mapping (live Done vs. persistenter Verlauf) ──────────────────────

function summaryFromResult(result: RunResult, writes: string[], abortRequested: boolean): SummaryVM {
  return {
    teamName: null,
    heading: t(`panel.status.${result.status}`),
    filesText: t("panel.done.filesWritten", result.writes),
    files: writes,
    commitText: result.commitSha === null ? null : t("panel.done.commit", shortSha(result.commitSha)),
    durationText: t("panel.done.duration", result.durationS),
    abortNote: abortNote(result.status, abortRequested),
    primaryLabel: result.status === "ok" ? t("panel.openLog") : t("panel.viewFailure"),
    undoLabel: t("panel.undo"),
    nextActionLabel: t("panel.nextAction"),
    nextActionText: nextActionText(result.status, result.errorKind),
  };
}

function summaryFromLastRun(s: RunSummary): SummaryVM {
  return {
    teamName: s.teamName,
    heading: t(`panel.status.${s.status}`),
    filesText: t("panel.done.filesWritten", s.writes),
    files: [],
    commitText: s.commitSha === null ? null : t("panel.done.commit", shortSha(s.commitSha)),
    durationText: t("panel.done.duration", s.durationS),
    abortNote: null,
    primaryLabel: s.status === "ok" ? t("panel.openLog") : t("panel.viewFailure"),
    undoLabel: t("panel.undo"),
    nextActionLabel: t("panel.nextAction"),
    nextActionText: nextActionText(s.status, s.errorKind),
  };
}

/** Ehrlicher Abbruch-Hinweis (§3): geklickt, aber regulär fertig → „war schon fertig";
 *  tatsächlich abgebrochen → knappe Bestätigung; sonst kein Hinweis. */
function abortNote(status: RunStatus, abortRequested: boolean): string | null {
  if (status === "aborted") return t("panel.abortNote.aborted");
  if (abortRequested && status === "ok") return t("panel.abortNote.finishedFirst");
  return null;
}

function nextActionText(status: RunStatus, errorKind: ErrorKind | null): string {
  if (errorKind !== null) return t(`notice.errorKind.${errorKind}`);
  return status === "ok" ? t("panel.nextAction.ok") : t("panel.nextAction.partial");
}

function shortSha(sha: string): string { return sha.slice(0, 7); }

export function formatRelative(nowMs: number, whenMs: number): string {
  const diffS = Math.max(0, Math.round((nowMs - whenMs) / 1000));
  if (diffS < 60) return t("panel.relative.justNow");
  const diffMin = Math.round(diffS / 60);
  if (diffMin < 60) return t("panel.relative.minutesAgo", diffMin);
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return t("panel.relative.hoursAgo", diffH);
  return t("panel.relative.daysAgo", Math.round(diffH / 24));
}
