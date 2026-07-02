// Crash-Recovery (Spec §5.3/§7): erkennt eine verwaiste `runs/.lock` +
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
import { RecorderGitPort } from "../helpers/recorder-git";
import { buildStateJson } from "../../src/core/run-log";
import type { CommitPlan, GitPort, GitStatusInfo } from "../../src/core/ports";
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
    baseSha: "base-sha",
    commitSha: null,
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

/** Git-Fake für die Reihenfolge-Regression (Fix 1): `applyPlan` liest bei jedem Aufruf
 *  denselben In-Memory-Vault, den der Test seedet — genau wie die Produktions-
 *  implementierung (`ChildProcessGitPort.applyPlan` stagt via `git add -- <paths>` von
 *  der Platte, nie aus dem In-Memory-State) — und protokolliert den zu diesem Zeitpunkt
 *  geparsten `status` von run.md/state.json. Deckt exakt den Bug auf, den ein reiner
 *  Recorder (der nur den übergebenen CommitPlan aufzeichnet, ihn aber nie gegen den
 *  Disk-Inhalt zum Aufrufzeitpunkt prüft) nicht sehen kann. */
class DiskSensingGitPort implements GitPort {
  readonly plans: CommitPlan[] = [];
  readonly seenStatuses: { runMd: string | null; stateJson: string | null }[] = [];
  private commitN = 0;

  constructor(
    private readonly vault: InMemoryVaultPort,
    private readonly runDir: string,
  ) {}

  async status(): Promise<GitStatusInfo> {
    return { isRepo: true, inMergeOrRebase: false, hasIndexLock: false, headSha: "base-sha", dirty: false };
  }

  async applyPlan(plan: CommitPlan): Promise<string> {
    this.seenStatuses.push({
      runMd: await this.readFrontmatterStatus(`${this.runDir}/run.md`),
      stateJson: await this.readJsonStatus(`${this.runDir}/state.json`),
    });
    this.plans.push(plan);
    this.commitN += 1;
    return `sha-${this.commitN}`;
  }

  async revert(_sha: string): Promise<{ ok: boolean; conflictPaths: string[] }> {
    return { ok: true, conflictPaths: [] };
  }

  async restorePaths(_sha: string, _paths: string[]): Promise<void> {
    // no-op — nicht Teil dieser Regression
  }

  private async readFrontmatterStatus(path: string): Promise<string | null> {
    try {
      return /^status:\s*(\S+)/m.exec(await this.vault.read(path))?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async readJsonStatus(path: string): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(await this.vault.read(path));
      const status = (parsed as { status?: unknown }).status;
      return typeof status === "string" ? status : null;
    } catch {
      return null;
    }
  }
}

describe("checkOrphanedRun", () => {
  it("returns the orphan when the lock is active and state.json still says 'running'", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
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
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: false }));
    await vault.create(`${CREW_ROOT}/runs/${state.runId}/state.json`, buildStateJson(state));

    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null when state.json is no longer 'running', even if the lock still reads active", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState({ status: "ok", endedAt: 2_000, commitSha: "sha1" });
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${CREW_ROOT}/runs/${state.runId}/state.json`, buildStateJson(state));

    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null when there is no lock file at all", async () => {
    const vault = new InMemoryVaultPort();
    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });

  it("returns null for a corrupt lock file (treated like the orchestrator's silent takeover)", async () => {
    const vault = new InMemoryVaultPort();
    await vault.create(`${CREW_ROOT}/runs/.lock`, "{not json");
    expect(await checkOrphanedRun(vault, CREW_ROOT)).toBeNull();
  });
});

describe("RecoveryModal", () => {
  it("shows exactly one recommended action button, labelled to finish the orphaned run", () => {
    const vault = new InMemoryVaultPort();
    const git = new RecorderGitPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault, git });

    modal.onOpen();

    const buttons = findAll(modal.contentEl, (e) => e.tagName === "BUTTON");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Finish orphaned run (commit partial state)");
  });

  it("finishing commits the partial state, rewrites run.md to aborted with the commit sha, and releases the lock", async () => {
    const vault = new InMemoryVaultPort();
    const git = new RecorderGitPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${runDir}/state.json`, buildStateJson(state));
    await vault.create(`${runDir}/run.md`, "---\nstatus: running\n---\n\n# stub\n");

    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault, git });

    await modal.finish();

    expect(git.plans).toHaveLength(1);
    expect(git.plans[0]?.paths).toContain(runDir);
    // Commit-Message spiegelt den finalen (aborted) Status, nicht den geerbten 'running'-Rohzustand.
    expect(git.plans[0]?.message).toContain("aborted");

    const runMd = await vault.read(`${runDir}/run.md`);
    expect(runMd).toContain("status: aborted");
    expect(runMd).toContain(`commit: ${git.plans.length > 0 ? "sha-1" : ""}`);

    const lock = JSON.parse(await vault.read(`${CREW_ROOT}/runs/.lock`)) as { active: boolean };
    expect(lock.active).toBe(false);
  });

  it("clicking the recommended action triggers the same finish() effect", async () => {
    const vault = new InMemoryVaultPort();
    const git = new RecorderGitPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${runDir}/state.json`, buildStateJson(state));
    await vault.create(`${runDir}/run.md`, "---\nstatus: running\n---\n\n# stub\n");

    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault, git });
    modal.onOpen();

    const [button] = findAll(modal.contentEl, (e) => e.tagName === "BUTTON");
    button?.click();
    // click() im Mock feuert Listener fire-and-forget (kein Await der Promise). finish()
    // hängt inzwischen mehrere awaits (run.md/state.json/lock vor dem Commit) hintereinander
    // — statt Microtask-Ticks zu zählen, wartet ein Macrotask: der läuft garantiert erst NACH
    // allen ausstehenden Microtasks, und vault/git sind hier synchron auflösende In-Memory-Fakes.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(git.plans).toHaveLength(1);
  });
});

describe("RecoveryModal.finish() — atomic commit ordering (regression)", () => {
  it("commits ABORTED run.md/state.json content, never the stale RUNNING disk snapshot, and rewrites state.json", async () => {
    const vault = new InMemoryVaultPort();
    const state = runningState();
    const runDir = `${CREW_ROOT}/runs/${state.runId}`;
    await vault.create(`${CREW_ROOT}/runs/.lock`, JSON.stringify({ active: true, runId: state.runId, startedAt: state.startedAt }));
    await vault.create(`${runDir}/state.json`, buildStateJson(state));
    await vault.create(`${runDir}/run.md`, "---\nstatus: running\n---\n\n# stub\n");

    const git = new DiskSensingGitPort(vault, runDir);
    const modal = new RecoveryModal(makeFakeApp() as unknown as App, { runId: state.runId, runDir, state }, { vault, git });

    await modal.finish();

    // Der Bug (Fix 1): applyPlan() liest via `git add -- <paths>` von der Platte — wenn
    // finish() erst committet und danach schreibt, sieht der Commit noch den ererbten
    // "running"-Snapshot, obwohl die Commit-Message schon "aborted" sagt.
    expect(git.seenStatuses).toHaveLength(1);
    expect(git.seenStatuses[0]).toEqual({ runMd: "aborted", stateJson: "aborted" });

    // state.json wurde vor diesem Fix NIE umgeschrieben (blieb für immer "running").
    const stateJsonAfter = JSON.parse(await vault.read(`${runDir}/state.json`)) as { status?: unknown };
    expect(stateJsonAfter.status).toBe("aborted");

    const lock = JSON.parse(await vault.read(`${CREW_ROOT}/runs/.lock`)) as { active: boolean };
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
