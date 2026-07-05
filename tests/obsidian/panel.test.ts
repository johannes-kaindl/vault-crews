// RunPanelView (Spec §6.2): idle Team-Liste, running Task-Kopf + Vokabular + EIN
// Cancel-Button, done Ergebnis-Karte mit genau EINEM kontextabhängigen Primärbutton.
// PanelHost entkoppelt die View bewusst von main.ts (Task 17-Vertrag; main.ts kommt
// im NÄCHSTEN Task) — der Fake-Host hier steht stellvertretend für das spätere
// Plugin-Objekt, genau wie SettingsHost in settings.test.ts. Ebenso übernommen: die
// dortige Konvention, Fakes über `as unknown as T` statt `new EchteObsidianKlasse()`
// zu bauen (reale .d.ts-Signaturen vs. loser Laufzeit-Mock).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeApp } from "../__mocks__/obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import { RunPanelView, VIEW_TYPE_CREWS, type PanelHost, type PanelTeam } from "../../src/obsidian/panel";
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

function driveEvents(view: RunPanelView, events: RunEvent[]): void {
  for (const e of events) view.handleEvent(e);
}

describe("RunPanelView — identity", () => {
  it("exposes the fixed view type, a display text and an icon", () => {
    const view = new RunPanelView(makeLeaf(), makeHost());
    expect(view.getViewType()).toBe(VIEW_TYPE_CREWS);
    expect(VIEW_TYPE_CREWS).toBe("vault-crews-panel");
    expect(view.getDisplayText().length).toBeGreaterThan(0);
    expect(view.getIcon().length).toBeGreaterThan(0);
  });
});

describe("RunPanelView — idle state", () => {
  const teams: PanelTeam[] = [
    { id: "task-triage", name: "Task triage", description: "Sorts inbox tasks.", lastRun: null },
    { id: "daily-briefing", name: "Daily briefing", description: "Writes the daily note.", lastRun: { status: "ok", when: 0 } },
  ];

  it("renders exactly one Run button per team", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    const runButtons = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Run");
    expect(runButtons).toHaveLength(2);
  });

  it("clicking a team's Run button calls host.runCrew with that team's id", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    const runButtons = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Run");
    runButtons[0]?.click();
    runButtons[1]?.click();

    expect(host.runCrew).toHaveBeenNthCalledWith(1, "task-triage");
    expect(host.runCrew).toHaveBeenNthCalledWith(2, "daily-briefing");
  });

  it("shows 'Never run' for a team with no last run, and a status word for one that has run", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain("Never run");
    expect(view.contentEl.textContent).toContain("Ok");
  });

  it("renders no configuration controls — only name, description and a Run button", async () => {
    const host = makeHost({ getTeams: vi.fn().mockReturnValue(teams) });
    const view = new RunPanelView(makeLeaf(), host);
    await view.onOpen();

    const inputs = findAll(view.contentEl, (e) => e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA");
    expect(inputs).toHaveLength(0);
  });
});

describe("RunPanelView — handleEvent drives running state", () => {
  it("runStarted → taskStarted sets the header to 'Task k/n: taskId' and shows exactly one red Cancel button", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 2 },
    ]);

    const headers = findAll(view.contentEl, (e) => e.tagName === "H2");
    expect(headers[0]?.textContent).toBe("Task 1/2: collect");

    const cancelButtons = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel");
    expect(cancelButtons).toHaveLength(1);
    expect(cancelButtons[0]?.hasClass("mod-warning")).toBe(true);
  });

  it("clicking Cancel while running calls host.abortCurrentRun exactly once", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
    ]);

    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel");
    cancel?.click();

    expect(host.abortCurrentRun).toHaveBeenCalledTimes(1);
  });

  it("clicking Cancel gives instant feedback: button becomes a disabled 'Cancelling…' and survives later token events", () => {
    // Smoke-Fund „Button schien keine Reaktion zu zeigen": der Abbruch wirkt am Backend,
    // aber ohne synchrone Quittung, und die nächste Event-Latenz (Stream-Teardown + Commit)
    // friert das Panel ein. Der Klick muss SOFORT sichtbar quittieren, und der Zustand
    // muss die Token-Re-Renders überleben (sonst taucht der aktive Cancel-Button wieder auf).
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "analyse", index: 1, total: 1 },
    ]);

    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel");
    cancel?.click();

    expect(findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel")).toHaveLength(0);
    const cancelling = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancelling…");
    expect(cancelling).toHaveLength(1);
    expect((cancelling[0] as unknown as { disabled: boolean }).disabled).toBe(true);

    // Ein spätes token-Event (Stream läuft noch aus) darf keinen aktiven Cancel wiederbeleben.
    driveEvents(view, [{ type: "token", taskId: "analyse", isThink: false }]);
    expect(findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel")).toHaveLength(0);
    expect(findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancelling…")).toHaveLength(1);
  });

  it("a second click on the cancelling button does not fire another abort", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "analyse", index: 1, total: 1 },
    ]);

    const [cancel] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel");
    cancel?.click();
    const [cancelling] = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancelling…");
    cancelling?.click();

    expect(host.abortCurrentRun).toHaveBeenCalledTimes(1);
  });

  it("token events update the collapsed progress counter and the think counter separately", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "token", taskId: "collect", isThink: false },
      { type: "token", taskId: "collect", isThink: false },
      { type: "token", taskId: "collect", isThink: true },
    ]);

    expect(view.contentEl.textContent).toContain("Streaming… 2 tokens");
    expect(view.contentEl.textContent).toContain("Thinking… 1 tokens");
  });

  it("the think counter lives in a collapsible <details> that is never forced open", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "token", taskId: "collect", isThink: true },
    ]);

    const [details] = findAll(view.contentEl, (e) => e.tagName === "DETAILS");
    expect(details).toBeDefined();
    expect(details?.getAttribute("open")).toBeNull();
  });

  it("taskFinished marks the task line status using the fixed vocabulary icon", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "taskFinished", taskId: "collect", status: "ok" },
    ]);

    expect(view.contentEl.textContent).toContain("✓");
    expect(view.contentEl.textContent).not.toContain("▶");
  });
});

describe("RunPanelView — handleEvent drives the done state", () => {
  function okResult(overrides: Partial<RunResult> = {}): RunResult {
    return { runId: "r1", status: "ok", commitSha: "abcdef1234567890", writes: 1, durationS: 12, errorTask: null, errorKind: null, ...overrides };
  }

  it("runFinished(ok) renders exactly one primary 'Open log' button, zero Cancel buttons", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "taskFinished", taskId: "collect", status: "ok" },
      { type: "runFinished", result: okResult() },
    ]);

    const primary = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-cta"));
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe("Open log");

    const cancel = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Cancel");
    expect(cancel).toHaveLength(0);

    primary[0]?.click();
    expect(host.openLog).toHaveBeenCalledTimes(1);
  });

  it("runFinished(failed) renders exactly one primary 'View failure' button", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      { type: "taskFinished", taskId: "collect", status: "failed" },
      {
        type: "runFinished",
        result: { runId: "r1", status: "failed", commitSha: "sha1234", writes: 0, durationS: 3, errorTask: "collect", errorKind: "io" },
      },
    ]);

    const primary = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.hasClass("mod-cta"));
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe("View failure");
    primary[0]?.click();
    expect(host.openLog).toHaveBeenCalledTimes(1);
  });

  it("shows exactly one quiet Undo button that calls host.undoLastRun", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "runFinished", result: okResult() },
    ]);

    const undo = findAll(view.contentEl, (e) => e.tagName === "BUTTON" && e.textContent === "Undo");
    expect(undo).toHaveLength(1);
    undo[0]?.click();
    expect(host.undoLastRun).toHaveBeenCalledTimes(1);
  });

  it("shows exactly one 'Next action' line", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "runFinished", result: okResult() },
    ]);

    const label = findAll(view.contentEl, (e) => e.textContent === "Next action" && e.tagName !== "DIV");
    expect(label.length).toBe(1);
  });

  it("shows the written files (accumulated from actionApplied) as links, the short commit sha and the duration", () => {
    const host = makeHost();
    const view = new RunPanelView(makeLeaf(), host);
    driveEvents(view, [
      { type: "runStarted", runId: "r1", teamId: "task-triage" },
      { type: "taskStarted", taskId: "collect", index: 1, total: 1 },
      {
        type: "actionApplied",
        outcome: { action: { type: "note.create", path: "Inbox/foo.md", content: "" }, result: "applied", reason: null },
      },
      {
        type: "actionApplied",
        outcome: { action: { type: "note.create", path: "rejected.md", content: "" }, result: "rejected", reason: "not in source" },
      },
      { type: "taskFinished", taskId: "collect", status: "ok" },
      { type: "runFinished", result: okResult({ commitSha: "abcdef1234567890" }) },
    ]);

    const links = findAll(view.contentEl, (e) => e.tagName === "A");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("Inbox/foo.md");
    expect(links[0]?.getAttribute("href")).toBe("Inbox/foo.md");

    expect(view.contentEl.textContent).toContain("Commit abcdef1");
    expect(view.contentEl.textContent).toContain("12s");
  });
});

describe("RunPanelView — no innerHTML", () => {
  it("the source never assigns .innerHTML (DOM built via createEl/createDiv only)", () => {
    const src = readFileSync(new URL("../../src/obsidian/panel.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});
