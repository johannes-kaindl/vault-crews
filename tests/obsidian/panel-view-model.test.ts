// Pure ViewModel-Schicht des Run-Panels (UI-STANDARD §6): reduceRun (State×Event) und
// buildPanelViewModel (State→ViewModel) sind obsidian-/DOM-frei und werden hier ohne Mock
// getestet. Die dünne Render-Seite (panel.ts) bleibt ungetestet.
import { beforeEach, describe, expect, it } from "vitest";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import {
  buildPanelViewModel, markAborting, reduceRun, runNoticeText, MAX_LIVE_CHARS,
  type RunState, type TeamInfo, type RunSummary, type PanelInputs,
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

function applyEvents(events: RunEvent[]): RunState {
  return drive({ kind: "idle" }, events);
}

function inputsWith(runState: RunState): PanelInputs {
  return { navState: "crews", runState, teams: [], latest: null, nowMs: 0, strayCount: 0 };
}

const okResult = (o: Partial<RunResult> = {}): RunResult => ({
  runId: "r1", status: "ok", undoable: true, writes: 1, durationS: 12, errorTask: null, errorKind: null, alwaysOnThinker: false, ...o,
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

  it("accumulates content into streamText and reasoning into thinkText, split by isThink", () => {
    const s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 1 },
      { type: "token", taskId: "a", isThink: false, text: "Hel" },
      { type: "token", taskId: "a", isThink: false, text: "lo" },
      { type: "token", taskId: "a", isThink: true, text: "hmm" },
    ]);
    expect(s.kind).toBe("running");
    if (s.kind !== "running") return;
    expect(s.streamText).toBe("Hello");
    expect(s.thinkText).toBe("hmm");
    expect(s.tokenCount).toBe(2);
    expect(s.thinkCount).toBe(1);
  });

  it("resets streamText and thinkText on taskStarted", () => {
    const s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 2 },
      { type: "token", taskId: "a", isThink: false, text: "first" },
      { type: "taskStarted", taskId: "b", index: 2, total: 2 },
    ]);
    if (s.kind !== "running") throw new Error("expected running");
    expect(s.streamText).toBe("");
    expect(s.thinkText).toBe("");
  });

  it("caps each live buffer to the last MAX_LIVE_CHARS characters", () => {
    const head = "a".repeat(500);
    const tail = "b".repeat(MAX_LIVE_CHARS);
    const s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 1 },
      { type: "token", taskId: "a", isThink: false, text: head + tail },
    ]);
    if (s.kind !== "running") throw new Error("expected running");
    expect(s.streamText.length).toBe(MAX_LIVE_CHARS);
    expect(s.streamText.startsWith("b")).toBe(true);   // tail kept
    expect(s.streamText.includes("a")).toBe(false);    // head dropped
  });
});

const teams: TeamInfo[] = [
  { id: "task-triage", name: "Task triage", description: "Sorts inbox.", lastRun: { status: "ok", when: 500 }, problem: null },
  { id: "daily-briefing", name: "Daily briefing", description: "Writes the note.", lastRun: null, problem: null },
];

describe("buildPanelViewModel — tabs & navigation", () => {
  it("marks the active tab from navState", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams, latest: null, nowMs: 1000 , strayCount: 0 });
    expect(vm.tabs.map((t) => [t.id, t.active])).toEqual([["crews", false], ["history", true]]);
  });

  it("shows no status line unless a run is active", () => {
    const idle = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(idle.statusLine).toBeNull();
    const running = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" });
    const vm = buildPanelViewModel({ navState: "history", runState: running, teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.statusLine).not.toBeNull(); // reachable even from the history tab
  });
});

describe("buildPanelViewModel — crews body", () => {
  it("idle with teams lists a run label per team and a status line per team", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 500 , strayCount: 0 });
    expect(vm.body.kind).toBe("crewsIdle");
    if (vm.body.kind === "crewsIdle") {
      expect(vm.body.empty).toBe(false);
      expect(vm.body.teams).toHaveLength(2);
      expect(vm.body.teams[1]?.statusText).toBe("Never run");
    }
  });

  it("idle with no teams flags empty and offers the install label", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams: [], latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.body.kind === "crewsIdle" && vm.body.empty).toBe(true);
    expect(vm.body.kind === "crewsIdle" && vm.body.installLabel.length).toBeGreaterThan(0);
  });

  it("running body carries icon-prefixed task lines and separate token/think counters", () => {
    const running = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 2 },
      { type: "token", taskId: "collect", isThink: false, text: "" },
      { type: "token", taskId: "collect", isThink: true, text: "" },
      { type: "taskFinished", taskId: "collect", status: "ok" },
    ]);
    const vm = buildPanelViewModel({ navState: "crews", runState: running, teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.body.kind).toBe("crewsRunning");
    if (vm.body.kind === "crewsRunning") {
      expect(vm.body.lines[0]?.icon).toBe("✓");
      expect(vm.body.streamText).toBe("");
      expect(vm.body.thinkingLabel).toContain("1");
    }
  });

  it("running body exposes live streamText/thinkText and an empty-placeholder", () => {
    const vmEmpty = buildPanelViewModel(inputsWith(applyEvents([
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 1 },
    ])));
    expect(vmEmpty.body.kind).toBe("crewsRunning");
    if (vmEmpty.body.kind !== "crewsRunning") return;
    expect(vmEmpty.body.streamText).toBe("");
    expect(vmEmpty.body.streamEmptyText.length).toBeGreaterThan(0);

    const vm = buildPanelViewModel(inputsWith(applyEvents([
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 1 },
      { type: "token", taskId: "a", isThink: false, text: "Hi" },
      { type: "token", taskId: "a", isThink: true, text: "mm" },
    ])));
    if (vm.body.kind !== "crewsRunning") throw new Error("expected crewsRunning");
    expect(vm.body.streamText).toBe("Hi");
    expect(vm.body.thinkText).toBe("mm");
    expect(vm.body.thinkingLabel).toContain("1"); // Zähler im Label
  });
});

describe("buildPanelViewModel — abort honesty (§3)", () => {
  function doneAfterAbort(status: RunResult["status"]): RunState {
    let s = reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" });
    s = markAborting(s);
    return reduceRun(s, { type: "runFinished", result: okResult({ status }) });
  }

  it("clicked abort but finished ok → 'finished first' note, not a frozen cancelling state", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: doneAfterAbort("ok"), teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.statusLine).toBeNull();
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toBe(
      "The run finished before the abort took effect — nothing was aborted.",
    );
  });

  it("actually aborted → aborted note", () => {
    const vm = buildPanelViewModel({ navState: "crews", runState: doneAfterAbort("aborted"), teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toContain("Aborted");
  });

  it("no abort click → no note", () => {
    const done = reduceRun(reduceRun({ kind: "idle" }, { type: "runStarted", runId: "r1", teamId: "t" }), { type: "runFinished", result: okResult() });
    const vm = buildPanelViewModel({ navState: "crews", runState: done, teams, latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.body.kind === "crewsDone" && vm.body.summary.abortNote).toBeNull();
  });
});

describe("buildPanelViewModel — history body", () => {
  const latest: RunSummary = {
    teamName: "Task triage", status: "ok", runId: "r9", undoable: true,
    when: 900, writes: 3, durationS: 7, errorKind: null,
  };

  it("empty history when there is no latest run", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams: [], latest: null, nowMs: 0 , strayCount: 0 });
    expect(vm.body.kind === "history" && vm.body.empty).toBe(true);
    expect(vm.body.kind === "history" && vm.body.latest).toBeNull();
  });

  it("shows the latest run summary (with team name, files count, undoable) and a per-crew list", () => {
    const vm = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams, latest, nowMs: 1000 , strayCount: 0 });
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

// Drei Zustaende, in denen das Panel bisher schwieg, obwohl es etwas zu sagen hatte
// (gemessen 2026-08-17 beim Bauen des Aufnahme-Fixtures). Alle drei kosten genau die
// Person Zeit, die gerade ihre ERSTE eigene Crew schreibt.
describe("stumme Zustaende", () => {
  const team = (o: Partial<TeamInfo> = {}): TeamInfo => ({
    id: "t1", name: "Team 1", description: "d", lastRun: null, problem: null, ...o,
  });

  // 1. Eine Crew-Datei flach im crewRoot wird ignoriert, und der leere Zustand sah
  //    genauso aus wie bei einem voellig leeren Vault: "No crews yet."
  it("benennt verirrte Crew-Dateien im leeren Zustand", () => {
    const vm = buildPanelViewModel({ ...inputsWith({ kind: "idle" }), strayCount: 2 });
    expect(vm.body.kind).toBe("crewsIdle");
    if (vm.body.kind !== "crewsIdle") return;
    expect(vm.body.empty).toBe(true);
    expect(vm.body.strayText).not.toBeNull();
    expect(vm.body.strayText).toContain("2");
  });

  it("benennt verirrte Dateien auch dann, wenn schon Crews da sind", () => {
    const vm = buildPanelViewModel({
      ...inputsWith({ kind: "idle" }), teams: [team()], strayCount: 1,
    });
    if (vm.body.kind !== "crewsIdle") return;
    expect(vm.body.empty).toBe(false);
    expect(vm.body.strayText).not.toBeNull();
  });

  it("schweigt, wenn nichts verirrt ist — kein Hinweis ohne Anlass", () => {
    const vm = buildPanelViewModel(inputsWith({ kind: "idle" }));
    if (vm.body.kind !== "crewsIdle") return;
    expect(vm.body.strayText).toBeNull();
  });

  // 3. Eine ungueltige Crew blieb gelistet (absichtlich — die Zeile soll startbar sein),
  //    aber ohne jeden Hinweis: starten, scheitern, Log oeffnen.
  it("reicht den Parse-Fehler einer Crew an die Zeile durch", () => {
    const vm = buildPanelViewModel({
      ...inputsWith({ kind: "idle" }),
      teams: [team({ problem: "agent 'fehlt' ist nicht bekannt" })],
    });
    if (vm.body.kind !== "crewsIdle") return;
    expect(vm.body.teams[0].problem).toBe("agent 'fehlt' ist nicht bekannt");
  });

  it("laesst problem null, wo die Crew in Ordnung ist", () => {
    const vm = buildPanelViewModel({ ...inputsWith({ kind: "idle" }), teams: [team()] });
    if (vm.body.kind !== "crewsIdle") return;
    expect(vm.body.teams[0].problem).toBeNull();
  });
});

describe("runNoticeText — Ursache statt „0 Dateien“", () => {
  it("nennt einen leeren Collector als eigene Ursache, wenn nichts geschrieben wurde", () => {
    const text = runNoticeText("Notiz-Tagger", okResult({ writes: 0, emptyCollector: "Notizen" }));
    expect(text).toBe("Notiz-Tagger: the collector found 0 matching notes in Notizen — check the folder/filter.");
  });

  it("bleibt beim normalen Satz, wenn trotz leerem Collector geschrieben wurde", () => {
    expect(runNoticeText("T", okResult({ writes: 2, emptyCollector: "x" }))).toBe("T: run completed — 2 file(s) written.");
  });

  it("verweigert: Klartext der Fehlerklasse, nie der rohe Schlüssel", () => {
    const text = runNoticeText("T", okResult({ status: "refused", writes: 0, errorKind: "endpoint_unreachable" }));
    expect(text).toContain("run refused");
    expect(text).toContain("Start LM Studio");
    expect(text).not.toContain("notice.errorKind");
  });
});

describe("buildPanelViewModel — Ursache im Panel", () => {
  it("Ergebnis-Karte: leerer Collector steht im Naechster-Schritt-Text", () => {
    const done: RunState = { kind: "done", result: okResult({ writes: 0, emptyCollector: "Notizen" }), writes: [], abortRequested: false };
    const vm = buildPanelViewModel(inputsWith(done));
    expect(vm.body.kind === "crewsDone" && vm.body.summary.nextActionText).toContain("0 matching notes in Notizen");
    expect(vm.body.kind === "crewsDone" && vm.body.summary.primaryLabel).toBe("Open log");
  });

  it("Team-Zeile: ein Lauf mit leerer Quelle nennt sie", () => {
    const team: TeamInfo = { id: "a", name: "A", description: "", problem: null, lastRun: { status: "partial", when: 0, emptyCollector: "Notizen" } };
    const vm = buildPanelViewModel({ ...inputsWith({ kind: "idle" }), teams: [team] });
    expect(vm.body.kind === "crewsIdle" && vm.body.teams[0]?.statusText).toContain("0 matching notes in Notizen");
  });

  it("Team-Zeile: eine verweigerte Crew nennt den Grund", () => {
    const team: TeamInfo = { id: "a", name: "A", description: "", problem: null, lastRun: { status: "refused", when: 0, errorKind: "crew_invalid" } };
    const vm = buildPanelViewModel({ ...inputsWith({ kind: "idle" }), teams: [team] });
    expect(vm.body.kind === "crewsIdle" && vm.body.teams[0]?.statusText).toContain("has an error");
  });
});
