// Crash-Recovery (Spec §5.3/§7): erkennt eine verwaiste `runs/run-lock.json` +
// `state.json status:'running'` beim nächsten Plugin-Load und bietet genau EINE
// empfohlene Handlung. Lock/State-Format hier ist exakt das, was der Orchestrator
// tatsächlich schreibt (src/core/orchestrator.ts `lockContent`/`releaseLock`/
// `persist`; siehe auch tests/core/orchestrator.test.ts "run lock"-Suite) — nicht
// geraten, sondern von dort übernommen:
//   aktiv:    {"active": true, "runId": "<id>", "startedAt": <ms>}   (acquireLock)
//   released: {"active": false}                                     (releaseLock)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFakeApp } from "../__mocks__/obsidian";
import type { App } from "obsidian";
import { InMemoryVaultPort } from "../helpers/in-memory-vault";
import { buildStateJson } from "../../src/core/run-log";
import type { RunState } from "../../src/core/types";
import { registerI18n } from "../../src/i18n/strings";
import { setLang } from "../../src/vendor/kit/i18n";
import { checkOrphanedRun, RecoveryModal } from "../../src/obsidian/recovery";

beforeEach(() => {
  registerI18n();
  setLang("en");
});
afterEach(() => {
  setLang("en");
});

const CREW_ROOT = "_crews";

function runningState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "2026-07-02-0900-task-triage",
    teamId: "task-triage",
    teamPath: "_crews/teams/task-triage.md",
    status: "running",
    startedAt: 1_000,
    endedAt: null,
    model: "some-model",
    contextLength: 8192,
    writeRegister: ["Inbox/foo.md"],
    llmCalls: 1,
    tasks: [],
    errorTask: null,
    errorKind: null,
    ...overrides,
  };
}

function findAll(el: HTMLElement, pred: (e: HTMLElement) => boolean, out: HTMLElement[] = []): HTMLElement[] {
  if (pred(el)) out.push(el);
  for (const c of Array.from(el.children) as HTMLElement[]) findAll(c, pred, out);
  return out;
}

describe("checkOrphanedRun", () => {
  it("returns the orphan when the lock is active and state.json still says 'running'", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${CREW_ROOT}/runs/${state.runId}/state.json`, buildStateJson(state));

    const orphan = await checkOrphanedRun(vault, CREW_ROOT);

    expect(orphan).not.toBeNull();
    expect(orphan?.runId).toBe(state.runId);
    expect(orphan?.runDir).toBe(`${CREW_ROOT}/runs/${state.runId}`);
    expect(orphan?.state.status).toBe("running");
    expect(orphan?.state.teamId).toBe("task-triage");
  });

  it("returns null once the lock has been released (normal run end)", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, JSON.stringify({ active: false }));
    await vault.create(`${CREW_ROOT}/runs/${state.runId}/state.json`, buildStateJson(state));

    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null when state.json is no longer 'running', even if the lock still reads active", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState({ status: "ok", endedAt: 2_000 });
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${CREW_ROOT}/runs/${state.runId}/state.json`, buildStateJson(state));

    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null when there is no lock file at all", async () => {
    const vault = new InMemoryVaultPort();
    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null for a corrupt lock file (treated like the orchestrator's silent takeover)", async () => {
    const vault = new InMemoryVaultPort();
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, "{not json");
    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });
});

describe("RecoveryModal", () => {
  it("shows exactly one recommended action button, labelled to finish the orphaned run", () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault });

    modal.onOpen();

    const buttons = findAll(modal.contentEl, (e) => e.tagName === "BUTTON");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Finish orphaned run (keep partial changes)");
  });

  it("finishing writes run.md/state.json as aborted and releases the lock — no git commit", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${runDir}/state.json`, buildStateJson(state));
    await vault.create(`${runDir}/run.md`, "---\nstatus: running\n---\n\n# stub\n");

    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault });

    await modal.finish();

    // run.md UND state.json tragen den finalen aborted-Status (state.json blieb früher
    // fälschlich "running", weil es nach dem Commit nie neu geschrieben wurde).
    expect(await vault.read(`${runDir}/run.md`)).toContain("status: aborted");
    const stateJsonAfter = JSON.parse(await vault.read(`${runDir}/state.json`)) as { status?: unknown };
    expect(stateJsonAfter.status).toBe("aborted");
    // Kein Commit/SHA mehr — das Snapshot-Netz macht git überflüssig.
    expect(await vault.read(`${runDir}/run.md`)).not.toContain("commit:");

    const lock = JSON.parse(await vault.read(`${CREW_ROOT}/runs/run-lock.json`)) as { active: boolean };
    expect(lock.active).toBe(false);
  });

  it("clicking the recommended action triggers the same finish() effect", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    await vault.create(`${CREW_ROOT}/runs/run-lock.json`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${runDir}/state.json`, buildStateJson(state));
    await vault.create(`${runDir}/run.md`, "---\nstatus: running\n---\n\n# stub\n");

    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault });
    modal.onOpen();

    const [button] = findAll(modal.contentEl, (e) => e.tagName === "BUTTON");
    button?.click();
    // click() feuert den Listener fire-and-forget; ein Macrotask läuft garantiert erst NACH
    // allen ausstehenden Microtasks, und der In-Memory-Vault löst synchron auf.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await vault.read(`${runDir}/run.md`)).toContain("status: aborted");
    const lock = JSON.parse(await vault.read(`${CREW_ROOT}/runs/run-lock.json`)) as { active: boolean };
    expect(lock.active).toBe(false);
  });
});

describe("recovery.ts — no innerHTML", () => {
  it("the source never assigns .innerHTML (DOM built via createEl/createDiv only)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/obsidian/recovery.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});
