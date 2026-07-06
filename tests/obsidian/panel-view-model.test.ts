// Pure ViewModel-Schicht des Run-Panels (UI-STANDARD §6): reduceRun (State×Event) und
// buildPanelViewModel (State→ViewModel) sind obsidian-/DOM-frei und werden hier ohne Mock
// getestet. Die dünne Render-Seite (panel.ts) bleibt ungetestet.
import { beforeEach, describe, expect, it } from "vitest";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import {
  buildPanelViewModel, markAborting, reduceRun,
  type RunState, type TeamInfo, type RunSummary,
} from "../../src/obsidian/panel-view-model";
import type { RunEvent } from "../../src/core/ports";
import type { RunResult } from "../../src/core/types";

beforeEach(() => {
  registerI18n();
  setLang("en");
});

function drive(state: RunState, events: RunEvent[]): RunState {
  let s = state;
  for (const e of events) s = reduceRun(s, e);
  return s;
}

const okResult = (o: Partial<RunResult> = {}): RunResult => ({
  runId: "r1", status: "ok", undoable: true, writes: 1, durationS: 12, errorTask: null, errorKind: null, ...o,
});

describe("reduceRun", () => {
  it("runStarted creates a fresh running state with empty writes and aborting=false", () => {
    const s = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "task-triage" });
    expect(s.kind).toBe("running");
    if (s.kind === "running") {
      expect(s.writes).toEqual([]);
      expect(s.aborting).toBe(false);
    }
  });

  it("actionApplied accumulates applied write paths and dedupes; rejects non-applied", () => {
    const s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "actionApplied", outcome: { action: { type: "note.create", path: "A.md", content: "" }, result: "applied", reason: null } },
      { type: "actionApplied", outcome: { action: { type: "note.create", path: "A.md", content: "" }, result: "applied", reason: null } },
      { type: "actionApplied", outcome: { action: { type: "note.create", path: "B.md", content: "" }, result: "rejected", reason: "x" } },
    ]);
    expect(s.kind === "running" && s.writes).toEqual(["A.md"]);
  });

  it("runFinished carries the accumulated writes and the abortRequested flag into done", () => {
    let s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "actionApplied", outcome: { action: { type: "note.create", path: "A.md", content: "" }, result: "applied", reason: null } },
    ]);
    s = markAborting(s);
    s = reduceRun(s, { type: "runFinished", result: okResult() });
    expect(s.kind).toBe("done");
    if (s.kind === "done") {
      expect(s.writes).toEqual(["A.md"]);
      expect(s.abortRequested).toBe(true);
    }
  });

  it("markAborting is idempotent and only affects a running state", () => {
    expect(markAborting({ kind: "idle" }).kind).toBe("idle");
    const running = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" });
    const once = markAborting(running);
    const twice = markAborting(once);
    expect(twice.kind === "running" && twice.aborting).toBe(true);
  });
});

const teams: TeamInfo[] = [
  { id: "task-triage", name: "Task triage", description: "Sorts inbox.", lastRun: { status: "ok", when: 500 } },
  { id: "daily-briefing", name: "Daily briefing", description: "Writes the note.", lastRun: null },
];

describe("buildPanelViewModel — tabs & navigation", () => {
  it("marks the active tab from navState", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams, latest: null, nowMs: 1000 });
    expect(vm.tabs.map((t) => [t.id, t.active])).toEqual([["crews", false], ["history", true]]);
  });

  it("shows no status line unless a run is active", () => {
    const idle = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 0 });
    expect(idle.statusLine).toBeNull();
    const running = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" });
    const vm = buildPanelViewModel({ navState: "history", runState: running, teams, latest: null, nowMs: 0 });
    expect(vm.statusLine).not.toBeNull(); // reachable even from the history tab
  });
});

describe("buildPanelViewModel — crews body", () => {
  it("idle with teams lists a run label per team and a status line per team", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 500 });
    expect(vm.body.kind).toBe("crewsIdle");
    if (vm.body.kind === "crewsIdle") {
      expect(vm.body.empty).toBe(false);
      expect(vm.body.teams).toHaveLength(2);
      expect(vm.body.teams[1]?.statusText).toBe("Never run");
    }
  });

  it("idle with no teams flags empty and offers the install label", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams: [], latest: null, nowMs: 0 });
    expect(vm.body.kind === "crewsIdle" && vm.body.empty).toBe(true);
    expect(vm.body.kind === "crewsIdle" && vm.body.installLabel.length).toBeGreaterThan(0);
  });

  it("running body carries icon-prefixed task lines and separate token/think counters", () => {
    const running = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 2 },
      { type: "token", taskId: "collect", isThink: false },
      { type: "token", taskId: "collect", isThink: true },
      { type: "taskFinished", taskId: "collect", status: "ok" },
    ]);
    const vm = buildPanelViewModel({ navState: "crews", runState: running, teams, latest: null, nowMs: 0 });
    expect(vm.body.kind).toBe("crewsRunning");
    if (vm.body.kind === "crewsRunning") {
      expect(vm.body.lines[0]?.icon).toBe("✓");
      expect(vm.body.streamingText).toContain("1");
      expect(vm.body.thinkingText).toContain("1");
    }
  });
});

describe("buildPanelViewModel — abort honesty (§3)", () => {
  function doneAfterAbort(status: RunResult["status"]): RunState {
    let s = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" });
    s = markAborting(s);
    return reduceRun(s, { type: "runFinished", result: okResult({ status }) });
  }

  it("clicked abort but finished ok → 'finished first' note, not a frozen cancelling state", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: doneAfterAbort("ok"), teams, latest: null, nowMs: 0 });
    expect(vm.statusLine).toBeNull();
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toBe(
      "The run finished before the abort took effect — nothing was aborted.",
    );
  });

  it("actually aborted → aborted note", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: doneAfterAbort("aborted"), teams, latest: null, nowMs: 0 });
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toContain("Aborted");
  });

  it("no abort click → no note", () => {
    const done = reduceRun(reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" }), { type: "runFinished", result: okResult() });
    const vm = buildPanelViewModel({ navState: "crews", runState: done, teams, latest: null, nowMs: 0 });
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toBeNull();
  });
});

describe("buildPanelViewModel — history body", () => {
  const latest: RunSummary = {
    teamName: "Task triage", status: "ok", runId: "r9", undoable: true,
    when: 900, writes: 3, durationS: 7, errorKind: null,
  };

  it("empty history when there is no latest run", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams: [], latest: null, nowMs: 0 });
    expect(vm.body.kind === "history" && vm.body.empty).toBe(true);
    expect(vm.body.kind === "history" && vm.body.latest).toBeNull();
  });

  it("shows the latest run summary (with team name, files count, undoable) and a per-crew list", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams, latest, nowMs: 1000 });
    expect(vm.body.kind).toBe("history");
    if (vm.body.kind === "history") {
      expect(vm.body.latest?.teamName).toBe("Task triage");
      expect(vm.body.latest?.filesText).toContain("3");
      expect(vm.body.latest?.undoable).toBe(true);
      // Only crews that have run appear; task-triage has a lastRun, daily-briefing does not.
      expect(vm.body.crews).toHaveLength(1);
      expect(vm.body.crews[0]?.teamId).toBe("task-triage");
    }
  });
});
