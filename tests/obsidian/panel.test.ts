// RunPanelView: dünne Render-Schicht über dem ViewModel (panel-view-model.test.ts deckt
// die Entscheidungslogik ab). Hier: DOM-Struktur + Verdrahtung der Klicks an den
// PanelHost, Tab-Navigation, Statuszeile. Fake-Host über `as unknown as T` (Konvention
// aus settings.test.ts).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp } from "../__mocks__/obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import { RunPanelView, VIEW_TYPE_CREWS, type PanelHost, type PanelTeam, type RunSummary } from "../../src/obsidian/panel";
import type { RunEvent } from "../../src/core/ports";
import type { RunResult } from "../../src/core/types";

beforeEach(() => {
  registerI18n();
  setLang("en");
});
afterEach(() => {
  setLang("en");
});

function makeHost(overrides: Partial<PanelHost> = {}): PanelHost {
  return {
    getTeams: vi.fn().mockReturnValue([]),
    runCrew: vi.fn(),
    abortCurrentRun: vi.fn(),
    undoLastRun: vi.fn(),
    openLog: vi.fn(),
    installExamples: vi.fn(),
    getLastRunSummary: vi.fn().mockReturnValue(null),
    openCrewLog: vi.fn(),
    ...overrides,
  };
}

function makeLeaf(): WorkspaceLeaf {
  return { app: makeFakeApp() } as unknown as WorkspaceLeaf;
}

/** Rekursive Suche über den Fake-El-Baum (kein querySelectorAll im Mock, PROF-OBS-08). */
function findAll(el: HTMLElement, pred: (e: HTMLElement) => boolean, out: HTMLElement[] = []): HTMLElement[] {
  if (pred(el)) out.push(el);
  for (const c of Array.from(el.children) as HTMLElement[]) findAll(c, pred, out);
  return out;
}
const buttons = (el: HTMLElement, text: string): HTMLElement[] =>
  findAll(el, (e) => e.tagName === "BUTTON" && e.textContent === text);

function driveEvents(view: RunPanelView, events: RunEvent[]): void {
  for (const e of events) view.handleEvent(e);
}

const okResult = (o: Partial<RunResult> = {}): RunResult => ({
  runId: "r1", status: "ok", commitSha: "abcdef1234567890", writes: 1, durationS: 12, errorTask: null, errorKind: null, ...o,
});

describe("RunPanelView — identity & shell", () => {
  it("exposes the fixed view type, a display text and an icon", () => {
    const view = new RunPanelView(makeLeaf(), makeHost());
    expect(view.getViewType()).toBe(VIEW_TYPE_CREWS);
    expect(VIEW_TYPE_CREWS).toBe("vault-crews-panel");
    expect(view.getDisplayText().length).toBeGreaterThan(0);
    expect(view.getIcon().length).toBeGreaterThan(0);
  });

  it("renders a Crews and a History tab", async () => {
    const view = new RunPanelView(makeLeaf(), makeHost());
    await view.onOpen();
    const tabs = findAll(view.contentEl, (e) => e.hasClass("vault-crews-tab"));
    expect(tabs.map((t) => t.textContent)).toEqual(["Crews", "History"]);
  });
});

describe("RunPanelView — crews idle", () => {
  const teams: PanelTeam[] = [
    { id: "task-triage", name: "Task triage", description: "Sorts inbox tasks.", lastRun: null },
    { id: "daily-briefing", name: "Daily briefing", description: "Writes the daily note.", lastRun: { status: "ok", when: 0 } },
  ];

  it("renders one Run button per team, wired to host.runCrew with the team id", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    const runButtons = buttons(view.contentEl, "Run");
    expect(runButtons).toHaveLength(2);
    runButtons[0]?.click();
    runButtons[1]?.click();
    expect(host.runCrew).toHaveBeenNthCalledWith(1, "task-triage");
    expect(host.runCrew).toHaveBeenNthCalledWith(2, "daily-briefing");
  });

  it("renders no configuration controls — only name, description, status and a Run button", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();
    const inputs = findAll(view.contentEl, (e) => e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA");
    expect(inputs).toHaveLength(0);
  });

  it("empty team list shows an Install button wired to host.installExamples", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue([]) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();
    const install = buttons(view.contentEl, "Install example crews");
    expect(install).toHaveLength(1);
    install[0]?.click();
    expect(host.installExamples).toHaveBeenCalledTimes(1);
  });
});

describe("RunPanelView — running state & status line", () => {
  function startRunning(host: PanelHost): RunPanelView {
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 2 },
    ]);
    return view;
  }

  it("shows a status line with progress and exactly one warning Cancel button", () => {
    const view = startRunning(makeHost());
    expect(view.contentEl.textContent).toContain("1/2");
    const cancel = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    expect(cancel).toHaveLength(1);
  });

  it("clicking Cancel calls host.abortCurrentRun once and turns the button into a disabled state", () => {
    const host = makeHost();
    const view = startRunning(host);
    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    cancel?.click();
    expect(host.abortCurrentRun).toHaveBeenCalledTimes(1);

    const [after] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    expect((after as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(view.contentEl.textContent).toContain("Abort requested");
  });

  it("a late token event does not revive an active Cancel button, and a second click does not re-abort", () => {
    const host = makeHost();
    const view = startRunning(host);
    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    cancel?.click();
    driveEvents(view, [{ type: "token", taskId: "collect", isThink: false }]);

    const [again] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    expect((again as unknown as { disabled: boolean }).disabled).toBe(true);
    again?.click();
    expect(host.abortCurrentRun).toHaveBeenCalledTimes(1);
  });

  it("task lines carry the fixed vocabulary icon and the think counter lives in a never-open <details>", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "token", taskId: "collect", isThink: true },
      { type: "taskFinished", taskId: "collect", status: "ok" },
    ]);
    expect(view.contentEl.textContent).toContain("✓");
    const [details] = findAll(view.contentEl, (e) => e.tagName === "DETAILS");
    expect(details?.getAttribute("open")).toBeNull();
  });
});

describe("RunPanelView — done state", () => {
  function done(view: RunPanelView, result: RunResult): void {
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "actionApplied", outcome: { action: { type: "note.create", path: "Inbox/foo.md", content: "" }, result: "applied", reason: null } },
      { type: "taskFinished", taskId: "collect", status: result.status === "ok" ? "ok" : "failed" },
      { type: "runFinished", result },
    ]);
  }

  it("ok renders one primary 'Open log', a quiet Undo, the written files as links, no Cancel", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    done(view, okResult());

    const primary = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-cta"));
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe("Open log");
    primary[0]?.click();
    expect(host.openLog).toHaveBeenCalledTimes(1);

    const undo = buttons(view.contentEl, "Undo");
    expect(undo).toHaveLength(1);
    undo[0]?.click();
    expect(host.undoLastRun).toHaveBeenCalledTimes(1);

    const links = findAll(view.contentEl, (e) => e.tagName === "A");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["Inbox/foo.md"]);
    expect(findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"))).toHaveLength(0);
    expect(view.contentEl.textContent).toContain("Commit abcdef1");
  });

  it("failed renders one primary 'View failure'", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    done(view, okResult({ status: "failed", errorKind: "io", commitSha: "sha1234", writes: 0 }));
    const primary = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-cta"));
    expect(primary[0]?.textContent).toBe("View failure");
  });

  it("Back to overview returns to the idle team list", () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue([{ id: "t", name: "T", description: "", lastRun: null }]) });
    const view = new RunPanelView(makeLeaf(), host);
    done(view, okResult());
    const [back] = buttons(view.contentEl, "Back to overview");
    back?.click();
    expect(buttons(view.contentEl, "Run")).toHaveLength(1);
  });

  it("clicked abort but finished ok shows the honest 'finished before abort' note", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
    ]);
    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-warning"));
    cancel?.click();
    driveEvents(view, [{ type: "runFinished", result: okResult() }]);
    expect(view.contentEl.textContent).toContain("nothing was aborted");
  });
});

describe("RunPanelView — history tab", () => {
  const latest: RunSummary = {
    teamName: "Task triage", status: "ok", runId: "r9", commitSha: "abcdef1234567890",
    when: 0, writes: 3, durationS: 7, errorKind: null,
  };
  const teams: PanelTeam[] = [
    { id: "task-triage", name: "Task triage", description: "", lastRun: { status: "ok", when: 100 } },
  ];

  it("switching to History shows the latest run summary and a per-crew row wired to openCrewLog", async () => {
    const host = makeHost({
      getTeams: vi.fn().mockReturnValue(teams),
      getLastRunSummary: vi.fn().mockReturnValue(latest),
    });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    const [historyTab] = findAll(view.contentEl, (e) => e.hasClass("vault-crews-tab") && e.textContent === "History");
    (historyTab as unknown as HTMLElement).click();

    expect(view.contentEl.textContent).toContain("Task triage");
    expect(view.contentEl.textContent).toContain("Commit abcdef1");

    const [row] = findAll(view.contentEl, (e) => e.hasClass("vault-crews-history-row"));
    row?.click();
    expect(host.openCrewLog).toHaveBeenCalledWith("task-triage");
  });

  it("empty history shows a placeholder", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue([]), getLastRunSummary: vi.fn().mockReturnValue(null) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();
    const [historyTab] = findAll(view.contentEl, (e) => e.hasClass("vault-crews-tab") && e.textContent === "History");
    (historyTab as unknown as HTMLElement).click();
    expect(view.contentEl.textContent).toContain("No runs yet");
  });
});

describe("RunPanelView — no innerHTML", () => {
  it("the source never assigns .innerHTML (DOM built via createEl/createDiv only)", () => {
    const src = readFileSync(new URL("../../src/obsidian/panel.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});
