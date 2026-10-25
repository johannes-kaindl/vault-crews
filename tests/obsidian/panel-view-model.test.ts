// Pure ViewModel-Schicht des Run-Panels (UI-STANDARD §6): reduceRun (State×Event) und
// buildPanelViewModel (State→ViewModel) sind obsidian-/DOM-frei und werden hier ohne Mock
// getestet. Die dünne Render-Seite (panel.ts) bleibt ungetestet.
import { beforeEach, describe, expect, it } from "vitest";
import { DE, EN, registerI18n } from "../../src/i18n/strings";
import type { CrewModelRow } from "../../src/core/model-resolution";
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
    expect(s.thinkCount).toBe(1);   // 3 Zeichen → ⌈3 / 3,5⌉ = 1
    // Ein einziges Stück mit viel Denken zählt nach Zeichen, nicht als „1“ (Gemma 4: das ganze Denken kommt in einem Stück).
    const einStueck = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "a", index: 1, total: 1 },
      { type: "token", taskId: "a", isThink: true, text: "x".repeat(140) },
    ]);
    expect(einStueck.kind === "running" && einStueck.thinkCount).toBe(40);
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
  it("picks the body from navState (the tab bar itself is the Kit hub)", () => {
    const crews = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 1000, strayCount: 0 });
    const history = buildPanelViewModel({ navState: "history", runState: { kind: "idle" }, teams, latest: null, nowMs: 1000, strayCount: 0 });
    expect([crews.body.kind, history.body.kind]).toEqual(["crewsIdle", "history"]);
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
      expect(vm.body.lines[0]?.icon).toEqual({ name: "circle-check", cls: "is-ok" });
      expect(vm.body.lines[0]?.statusText).toBe("Ok");
      expect(vm.body.streamText).toBe("");
      expect(vm.body.thinkingLabel).toContain("0");   // leeres Denk-Stück: keine Zeichen, keine Token
    }
  });

  it("contentReset leert den Antworttext des laufenden Tasks und lässt das Denken stehen (Gemma 4 ohne Öffner)", () => {
    const s = drive({ kind: "idle" }, [
      { type: "runStarted", runId: "r1", teamId: "t" },
      { type: "taskStarted", taskId: "analyse", index: 1, total: 1 },
      { type: "token", taskId: "analyse", isThink: true, text: "Quellen " },
      { type: "token", taskId: "analyse", isThink: false, text: "Ich wäge die Quellen ab." },
      { type: "contentReset", taskId: "analyse" },
      { type: "token", taskId: "analyse", isThink: false, text: "Die Antwort." },
    ]);
    expect(s.kind === "running" && s.streamText).toBe("Die Antwort.");
    expect(s.kind === "running" && s.thinkText).toBe("Quellen ");
  });

  it("task lines use the status-indicator vocabulary: icon + state class + status text per status", () => {
    const statuses = ["waiting", "running", "ok", "failed", "skipped", "stale"] as const;
    const running: RunState = {
      kind: "running", runId: "r", teamId: "t", total: 6, index: 1, currentTaskId: null,
      lines: statuses.map((status, i) => ({ taskId: `t${i}`, status })),
      tokenCount: 0, thinkCount: 0, thinkChars: 0, streamText: "", thinkText: "", writes: [], aborting: false,
    };
    const vm = buildPanelViewModel({ navState: "crews", runState: running, teams, latest: null, nowMs: 0, strayCount: 0 });
    expect(vm.body.kind).toBe("crewsRunning");
    if (vm.body.kind !== "crewsRunning") return;
    expect(vm.body.lines.map((l) => l.icon)).toEqual([
      { name: "circle-dashed", cls: "" },
      { name: "loader", cls: "is-checking" },
      { name: "circle-check", cls: "is-ok" },
      { name: "circle-x", cls: "is-error" },
      { name: "circle-minus", cls: "" },
      { name: "alert-triangle", cls: "is-warning" },
    ]);
    // Textalternative: jede Zeile trägt den Statustext, nie nur ein Zeichen.
    expect(vm.body.lines.map((l) => l.statusText)).toEqual(["Waiting", "Running", "Ok", "Failed", "Skipped", "Stale"]);
    for (const l of vm.body.lines) expect(l.label.endsWith(l.statusText)).toBe(true);
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

  it("endpoint_unreachable mit Grund des Managers: der Grund ersetzt die allgemeine Zeile, andere Fehlerklassen bleiben unberührt", () => {
    const grund = "The endpoint has no API key.";
    const text = runNoticeText("T", okResult({ status: "refused", writes: 0, errorKind: "endpoint_unreachable" }), grund);
    expect(text).toContain(grund);
    expect(text).not.toContain("Start LM Studio");
    const other = runNoticeText("T", okResult({ status: "refused", writes: 0, errorKind: "model_missing" }), grund);
    expect(other).not.toContain(grund);
    expect(runNoticeText("T", okResult({ status: "refused", writes: 0, errorKind: "endpoint_unreachable" }), null)).toContain("Start LM Studio");
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

// Die nur lesende Modellanzeige je Crew (Welle 27, Variante B): welches Modell und welche Denkstufe jeder Agent bekommt. Das Panel pingt nicht,
// also sagt die Anzeige zweistufig, was sie weiß: Wunsch der Persona (gilt, wenn der Endpunkt es führt), sonst das Modell der Endpunkt-Zeile.
describe("buildPanelViewModel — Modelle je Crew", () => {
  const row = (over: Partial<CrewModelRow> = {}): CrewModelRow => ({
    taskId: "analyse", agentId: "analyst", agentName: "Analyst", wanted: null, fallback: "zeile-7b", effective: "zeile-7b", source: "endpoint", thinking: "off", ...over,
  });
  const team = (models: CrewModelRow[] | undefined, over: Partial<TeamInfo> = {}): TeamInfo => ({
    id: "t", name: "T", description: "", lastRun: null, problem: null, ...(models ? { models } : {}), ...over,
  });
  const idle = (teams: TeamInfo[]) => {
    const vm = buildPanelViewModel({ navState: "crews", runState: { kind: "idle" }, teams, latest: null, nowMs: 0, strayCount: 0 });
    if (vm.body.kind !== "crewsIdle") throw new Error("kein crewsIdle");
    return vm.body.teams;
  };

  it("ohne Persona-Modell: das Modell der Endpunkt-Zeile und die Denkstufe aus dem Persona-Frontmatter", () => {
    const [vm] = idle([team([row()])]);
    expect(vm?.models).toEqual({
      heading: "Models",
      lines: ["Analyst (analyse): zeile-7b — the endpoint row's model · thinking off"],
      settingsLabel: "Change the fallback model in the settings",
    });
  });

  it("mit Persona-Modell, ohne Lauf-Wissen: beide Stufen, nicht eine geratene", () => {
    const [vm] = idle([team([row({ wanted: "gross-27b", source: "conditional", thinking: "auto" })])]);
    expect(vm?.models?.lines).toEqual(["Analyst (analyse): gross-27b if the active endpoint has it, otherwise zeile-7b (endpoint row) · thinking auto"]);
  });

  it("Persona-Modell, wenn der Endpunkt es führt (source agent): nur das Modell", () => {
    const [vm] = idle([team([row({ wanted: "gross-27b", effective: "gross-27b", source: "agent", thinking: "on" })])]);
    expect(vm?.models?.lines).toEqual(["Analyst (analyse): gross-27b · thinking on"]);
  });

  it("kein Modell gewählt: sagt, dass der Lauf mit model_missing abbräche", () => {
    const [a] = idle([team([row({ fallback: "", effective: "", source: "none" })])]);
    expect(a?.models?.lines[0]).toContain("no model chosen");
    const [b] = idle([team([row({ wanted: "gross-27b", fallback: "", effective: "", source: "conditional" })])]);
    expect(b?.models?.lines[0]).toContain("gross-27b if the active endpoint has it");
    expect(b?.models?.lines[0]).toContain("no model");
  });

  it("Endpoint Manager entscheidet (Modell der Zeile unbekannt): sagt das, statt ein Modell zu erfinden", () => {
    const [a] = idle([team([row({ fallback: null, effective: "", source: "managed" })])]);
    expect(a?.models?.lines[0]).toBe("Analyst (analyse): the model the Endpoint Manager picks at the start · thinking off");
    const [b] = idle([team([row({ wanted: "gross-27b", fallback: null, effective: "", source: "conditional" })])]);
    expect(b?.models?.lines[0]).toBe("Analyst (analyse): gross-27b if the active endpoint has it, otherwise the model the Endpoint Manager picks · thinking off");
  });

  it("eine Zeile je llm-Task, in der Reihenfolge der Crew", () => {
    const [vm] = idle([team([row({ taskId: "a", agentName: "A" }), row({ taskId: "b", agentName: "B", thinking: "auto" })])]);
    expect(vm?.models?.lines.map((l) => l.slice(0, 7))).toEqual(["A (a): ", "B (b): "]);
  });

  it("eine Crew ohne llm-Task (oder mit Parse-Problem) hat keine Modell-Zeile und stürzt nicht ab", () => {
    const [a, b, c] = idle([team([]), team(undefined), team(undefined, { problem: "write_scope: kaputt" })]);
    expect([a?.models, b?.models, c?.models]).toEqual([null, null, null]);
    expect(c?.problem).toBe("write_scope: kaputt");
  });

  it("die Texte sind deutsch, wenn die Sprache deutsch ist", () => {
    setLang("de");
    const [vm] = idle([team([row({ wanted: "gross-27b", source: "conditional", thinking: "off" })])]);
    expect(vm?.models?.heading).toBe("Modelle");
    expect(vm?.models?.lines[0]).toContain("falls der aktive Endpunkt es führt");
    expect(vm?.models?.lines[0]).toContain("Denken aus");
  });

  it("jeder panel.models.*-Schlüssel steht in EN und DE", () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith("panel.models."));
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter((k) => !(k in DE))).toEqual([]);
    expect(Object.keys(DE).filter((k) => k.startsWith("panel.models.") && !(k in EN))).toEqual([]);
  });
});
