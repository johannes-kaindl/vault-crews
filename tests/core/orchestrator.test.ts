// tests/core/orchestrator.test.ts
import { describe, expect, it } from 'vitest';
import { executeRun, type RunDeps } from '../../src/core/orchestrator';
import type { LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo, RunEvent } from '../../src/core/ports';
import type { RunLimits } from '../../src/core/types';
import { expandTarget } from '../../src/core/paths';
import { InMemoryVaultPort, FixtureMetadataPort } from '../helpers/in-memory-vault';
import { FakeClock } from '../helpers/fake-clock';
import { RecorderReporter } from '../helpers/recorder-reporter';
import { FakeSnapshotStore, FinalizeFailsSnapshotStore } from '../helpers/fake-snapshot';
import { ScriptLlmClient, type ScriptedCall } from '../helpers/script-llm';

const START_MS = 1_700_000_000_000;

const LIMITS: RunLimits = {
  maxWrites: 10, maxLlmCalls: 4, wallClockMs: 600_000,
  maxNoteBytes: 65_536, callTimeoutMs: 300_000, stallTimeoutMs: 60_000,
};

const TRIAGE_OK = '{"items":[{"path":"10_Aufgaben/a.md","set":{"priority":"mittel"}}]}';
const TASK_NOTE = '---\npriority: 1_niedrig_🟢\n---\nInhalt\n';

type Settings = RunDeps['settings'];

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    crewRoot: '_crews', defaultModel: 'test-model', configDir: '.obsidian',
    endpoints: ['http://localhost:1234'], deniedEndpoints: [],
    limits: LIMITS, undoHistoryDepth: 15, ...overrides,
  };
}

interface TeamFm { [k: string]: unknown; }

function triageTeamFm(overrides: TeamFm = {}): TeamFm {
  return {
    'crew-kind': 'team', name: 'Task-Triage', version: 1, trigger: 'manual', description: '',
    limits: { max_writes: 10 },
    write_scope: ['10_Aufgaben/**/*.md'],
    tasks: [
      { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
      { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1', on_error: 'abort' },
      { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
    ],
    ...overrides,
  };
}

interface HarnessOpts {
  teamFm?: TeamFm;
  files?: Record<string, string>;
  agents?: Record<string, { fm: Record<string, unknown>; body: string }>;
  llm?: LlmClient;
  snapshot?: FakeSnapshotStore;
  clock?: FakeClock;
  abort?: AbortSignal;
  settings?: Partial<Settings>;
  seedLock?: string;
}

interface Harness {
  vault: InMemoryVaultPort;
  meta: FixtureMetadataPort;
  clock: FakeClock;
  reporter: RecorderReporter;
  snapshot: FakeSnapshotStore;
  llm: LlmClient;
  deps: RunDeps;
  teamPath: string;
}

async function harness(opts: HarnessOpts = {}): Promise<Harness> {
  const vault = new InMemoryVaultPort();
  const meta = new FixtureMetadataPort(vault);

  const teamPath = '_crews/teams/task-triage.md';
  await vault.create(teamPath, 'Doku fuer Menschen.');
  meta.setFrontmatter(teamPath, opts.teamFm ?? triageTeamFm());

  const agents = opts.agents ?? { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'Triage-Analyst' }, body: 'Du bist ein Triage-Analyst.' } };
  for (const [id, a] of Object.entries(agents)) {
    const p = `_crews/agents/${id}.md`;
    await vault.create(p, a.body);
    meta.setFrontmatter(p, a.fm);
  }

  const files = opts.files ?? { '10_Aufgaben/a.md': TASK_NOTE };
  for (const [p, c] of Object.entries(files)) await vault.create(p, c);

  if (opts.seedLock !== undefined) await vault.create('_crews/runs/run-lock.json', opts.seedLock);

  const clock = opts.clock ?? new FakeClock(START_MS);
  const reporter = new RecorderReporter();
  const snapshot = opts.snapshot ?? new FakeSnapshotStore();
  const llm = opts.llm ?? new ScriptLlmClient([{ content: TRIAGE_OK }]);
  const abort = opts.abort ?? new AbortController().signal;

  const deps: RunDeps = { vault, meta, llm, snapshot, clock, reporter, settings: baseSettings(opts.settings), abort };
  return { vault, meta, clock, reporter, snapshot, llm, deps, teamPath };
}

/** Non-token event types (token events are frequent and asserted separately). */
function backbone(reporter: RecorderReporter): string[] {
  return reporter.events.filter((e) => e.type !== 'token').map((e) => e.type);
}

/** Drive fake-clock timers (index.lock delays) until the run settles. */
async function runToCompletion<T>(p: Promise<T>, clock: FakeClock): Promise<T> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 200 && !done; i++) {
    await Promise.resolve();
    clock.tick(2000);
  }
  return p;
}

class ClockAdvancingLlm implements LlmClient {
  constructor(private readonly clock: FakeClock, private readonly advanceMs: number, private readonly content = TRIAGE_OK) {}
  async ping(): Promise<boolean> { return true; }
  setBase(): void { /* single-endpoint test double: no-op */ }
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string) => void): Promise<LlmStreamResult> {
    this.clock.tick(this.advanceMs);
    onToken(this.content);
    return { content: this.content, thinkTokens: 0, reasoned: false, finishReason: 'stop' };
  }
}

class AbortMidStreamLlm implements LlmClient {
  async ping(): Promise<boolean> { return true; }
  setBase(): void { /* single-endpoint test double: no-op */ }
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string) => void): Promise<LlmStreamResult> {
    onToken('{"it');
    onToken('ems":');
    return { content: '', thinkTokens: 0, reasoned: false, finishReason: 'aborted' };
  }
}

describe('executeRun — ok (happy triage path)', () => {
  it('runs collector→llm→actions, commits once, patches the note, emits ordered events', async () => {
    const h = await harness();
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
    expect(result.undoable).toBe(true);
    expect(result.writes).toBe(1);
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-task-triage$/);

    // Snapshot: der geänderte Pfad wurde vor dem Write erfasst + der Lauf finalisiert.
    expect(h.snapshot.finalized).toEqual([result.runId]);
    expect(h.snapshot.paths(result.runId)).toContain('10_Aufgaben/a.md');

    // the note was patched (no slug table → literal value)
    expect(await h.vault.read('10_Aufgaben/a.md')).toContain('priority: mittel');

    // event backbone + at least one content token (isThink false)
    expect(backbone(h.reporter)).toEqual([
      'runStarted',
      'taskStarted', 'taskFinished',
      'taskStarted', 'taskFinished',
      'taskStarted', 'actionApplied', 'taskFinished',
      'runFinished',
    ]);
    const tokenEvents = h.reporter.events.filter((e): e is Extract<RunEvent, { type: 'token' }> => e.type === 'token');
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents.every((e) => e.isThink === false)).toBe(true);

    // taskStarted indices are 1-based with total 3
    const started = h.reporter.events.filter((e): e is Extract<RunEvent, { type: 'taskStarted' }> => e.type === 'taskStarted');
    expect(started.map((e) => `${e.index}/${e.total}`)).toEqual(['1/3', '2/3', '3/3']);

    // run.md persisted with final status + commit; state.json parseable
    const runDir = `_crews/runs/${result.runId}`;
    const runMd = await h.vault.read(`${runDir}/run.md`);
    expect(runMd).toContain('status: ok');
    expect(runMd).toContain('undoable: true');
    const state = JSON.parse(await h.vault.read(`${runDir}/state.json`)) as { status: string; llmCalls: number };
    expect(state.status).toBe('ok');
    expect(state.llmCalls).toBe(1);
  });
});

describe('executeRun — repair loop', () => {
  it('repair-ok: invalid then valid → status ok, exactly 2 llm calls', async () => {
    const llm = new ScriptLlmClient([{ content: 'kein json' }, { content: TRIAGE_OK }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(llm.calls).toHaveLength(2);
    expect(h.snapshot.finalized).toContain(result.runId);
  });

  it('repair-fail-abort: invalid twice, on_error abort → failed invalid_output, no writes → not undoable', async () => {
    const llm = new ScriptLlmClient([{ content: 'kaputt' }, { content: 'immer noch kaputt' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('invalid_output');
    expect(result.errorTask).toBe('analyse');
    expect(result.writes).toBe(0);
    // Kein Write → kein Snapshot, nichts rückgängig zu machen (Lauf ist trotzdem sicher geloggt).
    expect(result.undoable).toBe(false);
    expect(h.snapshot.finalized).toEqual([]);
  });

  it('repair-fail-skip: on_error skip → task skipped, downstream skipped, status partial', async () => {
    const llm = new ScriptLlmClient([{ content: 'kaputt' }, { content: 'immer noch kaputt' }]);
    const teamFm = triageTeamFm({
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
        { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1', on_error: 'skip' },
        { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
      ],
    });
    const h = await harness({ llm, teamFm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('partial');
    expect(result.errorKind).toBeNull();
    expect(result.writes).toBe(0);
    expect(backbone(h.reporter)).toContain('runFinished');
    expect(result.undoable).toBe(false);
    const runDir = `_crews/runs/${result.runId}`;
    const state = JSON.parse(await h.vault.read(`${runDir}/state.json`)) as { tasks: { taskId: string; status: string }[] };
    expect(state.tasks.map((t) => t.status)).toEqual(['ok', 'skipped', 'skipped']);
  });
});

describe('executeRun — llm call errors', () => {
  it('timeout → failed with errorKind timeout, partial commit', async () => {
    const llm = new ScriptLlmClient([{ error: 'timeout' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('timeout');
    expect(result.errorTask).toBe('analyse');
    expect(result.undoable).toBe(false);
  });

  it('stall → failed with errorKind stalled', async () => {
    const llm = new ScriptLlmClient([{ error: 'stalled' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('stalled');
  });

  it('http error → failed with errorKind endpoint_error (nicht endpoint_unreachable)', async () => {
    const llm = new ScriptLlmClient([{ error: 'http' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('endpoint_error');
    expect(result.errorTask).toBe('analyse');
  });

  it('overflow-retry-ok: overflow then valid → halve material, retry, status ok, 2 calls', async () => {
    const script: ScriptedCall[] = [{ error: 'overflow' }, { content: TRIAGE_OK }];
    const llm = new ScriptLlmClient(script);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(llm.calls).toHaveLength(2);
    expect(result.writes).toBe(1);
  });
});

describe('executeRun — always-on-thinker Laufzeit-Detektion', () => {
  it('thinking off, aber Modell hat gedacht → alwaysOnThinker true (Name matcht Regex nicht)', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: true }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'off' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(result.alwaysOnThinker).toBe(true);
  });

  it('thinking off + kein Reasoning → alwaysOnThinker false', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: false }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'off' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.alwaysOnThinker).toBe(false);
  });

  it('thinking auto + Reasoning → alwaysOnThinker false (Suppression gar nicht angefordert)', async () => {
    // Beweist, dass die thinking==='off'-Bedingung load-bearing ist: bei erlaubtem
    // Denken (auto) ist Reasoning erwartet, keine Suppressions-Lücke → Flag bleibt false.
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: true }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'auto' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.alwaysOnThinker).toBe(false);
  });
});

describe('executeRun — abort + watchdog', () => {
  it('abort mid-stream: finishReason aborted → status aborted, partial commit', async () => {
    const h = await harness({ llm: new AbortMidStreamLlm() });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('aborted');
    expect(result.errorKind).toBe('aborted');
    expect(result.errorTask).toBe('analyse');
    expect(result.undoable).toBe(false);
    expect(h.reporter.events.some((e) => e.type === 'token')).toBe(true);
  });

  it('watchdog: wall-clock exceeded before a task → aborted, partial commit', async () => {
    const clock = new FakeClock(START_MS);
    const h = await harness({
      clock,
      llm: new ClockAdvancingLlm(clock, 5000),
      settings: { limits: { ...LIMITS, wallClockMs: 1000 } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('aborted');
    expect(result.errorKind).toBe('aborted');
    expect(result.errorTask).toBe('apply');
    expect(result.undoable).toBe(false);
  });
});

describe('executeRun — executor failures', () => {
  it('write_limit: too many patches → failed write_limit, partial writes snapshotted', async () => {
    const llm = new ScriptLlmClient([{
      content: '{"items":[{"path":"10_Aufgaben/a.md","set":{"priority":"mittel"}},{"path":"10_Aufgaben/b.md","set":{"priority":"hoch"}}]}',
    }]);
    const teamFm = triageTeamFm({ limits: { max_writes: 1 } });
    const h = await harness({ llm, teamFm, files: { '10_Aufgaben/a.md': TASK_NOTE, '10_Aufgaben/b.md': TASK_NOTE } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('write_limit');
    expect(result.errorTask).toBe('apply');
    expect(result.writes).toBe(1);
    // Der eine erlaubte Write wurde snapshottet → undo-bar, obwohl der Lauf fehlschlug.
    expect(result.undoable).toBe(true);
    expect(h.snapshot.finalized).toContain(result.runId);
  });

  it('consistency: >50% actions rejected → failed consistency, no writes', async () => {
    const llm = new ScriptLlmClient([{
      content: '{"items":[{"path":"10_Aufgaben/a.md","set":{"priority":"mittel"}},{"path":"10_Aufgaben/b.md","set":{"priority":"hoch"}},{"path":"10_Aufgaben/c.md","set":{"priority":"tief"}}]}',
    }]);
    const teamFm = triageTeamFm({ write_scope: ['10_Aufgaben/a.md'] });
    const h = await harness({
      llm, teamFm,
      files: { '10_Aufgaben/a.md': TASK_NOTE, '10_Aufgaben/b.md': TASK_NOTE, '10_Aufgaben/c.md': TASK_NOTE },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('consistency');
    expect(result.writes).toBe(0);
    expect(result.undoable).toBe(false);
  });
});

describe('executeRun — preflight refusals', () => {
  it('endpoint unreachable (no candidates) → refused endpoint_unreachable, no snapshot', async () => {
    const h = await harness({ settings: { endpoints: [] } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('endpoint_unreachable');
    expect(result.undoable).toBe(false);
    expect(h.snapshot.finalized).toEqual([]);
  });

  it('model missing → refused model_missing', async () => {
    const h = await harness({ settings: { defaultModel: 'ghost-model' } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('model_missing');
    expect(h.snapshot.finalized).toEqual([]);
  });

  it('crew invalid (unknown agent) → refused crew_invalid, nothing executed', async () => {
    const teamFm = triageTeamFm({
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
        { id: 'analyse', kind: 'llm', agent: 'does-not-exist', inputs: ['collect'], instruction: 'x', output_schema: 'triage-v1' },
        { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
      ],
    });
    const h = await harness({ teamFm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('crew_invalid');
    expect(h.snapshot.finalized).toEqual([]);
  });
});

describe('executeRun — endpoint failover + preflight crash-safety (review C1)', () => {
  it('failover: endpoints[0] unreachable, endpoints[1] reachable → run succeeds using the reachable endpoint, setBase called before listModels', async () => {
    class FailoverLlmClient extends ScriptLlmClient {
      readonly order: string[] = [];
      async ping(endpoint: string): Promise<boolean> { return endpoint === 'http://ep2:1234'; }
      setBase(endpoint: string): void { this.order.push(`setBase:${endpoint}`); super.setBase(endpoint); }
      async listModels(): Promise<string[]> { this.order.push('listModels'); return super.listModels(); }
    }
    const llm = new FailoverLlmClient([{ content: TRIAGE_OK }]);
    const h = await harness({ llm, settings: { endpoints: ['http://ep1:1234', 'http://ep2:1234'] } });
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
    // proves the run actually targeted the reachable failover endpoint, in the right order
    expect(llm.order).toEqual(['setBase:http://ep2:1234', 'listModels']);
    expect(llm.baseCalls).toEqual(['http://ep2:1234']);
  });

  it('crash-safety: listModels() throws unexpectedly during preflight → executeRun RESOLVES with a refused RunResult (endpoint_unreachable), never throws', async () => {
    class ThrowingLlmClient extends ScriptLlmClient {
      async listModels(): Promise<string[]> { throw new Error('boom: unexpected network failure'); }
    }
    const llm = new ThrowingLlmClient([]);
    const h = await harness({ llm });

    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('endpoint_unreachable');
    expect(h.snapshot.finalized).toEqual([]); // refused before any write, no snapshot
    // proves finishRefused's log path ran (not an uncaught throw bypassing run.md/lock)
    const runDir = `_crews/runs/${result.runId}`;
    expect(await h.vault.read(`${runDir}/run.md`)).toContain('status: refused');
  });
});

describe('executeRun — run lock', () => {
  it('lock-orphaned: stale lock (older than wallClockMs) → taken over, run proceeds to ok', async () => {
    const seedLock = JSON.stringify({ active: true, runId: 'old-run', startedAt: START_MS - LIMITS.wallClockMs - 1 });
    const h = await harness({ seedLock });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    // lock released (never committed) after the run
    const lock = JSON.parse(await h.vault.read('_crews/runs/run-lock.json')) as { active: boolean };
    expect(lock.active).toBe(false);
  });

  it('active lock (recent) → refused, no commit', async () => {
    const seedLock = JSON.stringify({ active: true, runId: 'other', startedAt: START_MS });
    const h = await harness({ seedLock });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(h.snapshot.finalized).toEqual([]);
  });

  it('lock-cycle: a run completes (releaseLock runs) → a SECOND executeRun right after is not refused by a stuck lock (acquire→release→re-acquire, end to end)', async () => {
    // Same deps/vault reused across both calls — the lock file written by the first
    // run's acquireLock() must actually be released by releaseLock() (vault.modify) for
    // the second run's acquireLock() to succeed. This is the exact lifecycle a dotfile
    // lock path breaks under InMemoryVaultPort's dotfile guard (which mirrors Obsidian's
    // TFile index — getAbstractFileByPath never indexes dotfiles, so real vault.read/
    // modify throw for one; see ObsidianVaultPort.file()).
    const clock = new FakeClock(START_MS);
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK }, { content: TRIAGE_OK }]);
    const h = await harness({ clock, llm });

    const first = await executeRun(h.teamPath, h.deps);
    expect(first.status).toBe('ok');

    clock.tick(60_000); // distinct runId for the second run
    const second = await executeRun(h.teamPath, h.deps);

    expect(second.status).not.toBe('refused');
    expect(second.errorKind).not.toBe('io');
  });
});

describe('executeRun — target threading (briefing-v1 → section.replace)', () => {
  it('resolves the downstream actions target and bakes it into the section.replace', async () => {
    const clock = new FakeClock(START_MS);
    const today = expandTarget('{{today}}', clock.now());
    const dailyPath = `Daily/${today}.md`;
    const teamFm: TeamFm = {
      'crew-kind': 'team', name: 'Daily-Briefing', version: 1, trigger: 'manual', description: '',
      limits: { max_writes: 5 },
      write_scope: ['Daily/**/*.md'],
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
        { id: 'write', kind: 'llm', agent: 'briefing-autor', inputs: ['collect'], instruction: 'Schreibe.', output_schema: 'briefing-v1', on_error: 'abort' },
        { id: 'publish', kind: 'actions', inputs: ['write'], allowed_actions: ['section.replace'], allowed_keys: null, target: 'Daily/{{today}}.md' },
      ],
    };
    const h = await harness({
      clock,
      teamFm,
      agents: { 'briefing-autor': { fm: { 'crew-kind': 'agent', name: 'Briefing-Autor' }, body: 'Du schreibst ein Briefing.' } },
      files: { '10_Aufgaben/a.md': TASK_NOTE, [dailyPath]: '# Daily\n' },
      llm: new ScriptLlmClient([{ content: '## Heute\n- Aufgabe X' }]),
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(result.writes).toBe(1);
    const daily = await h.vault.read(dailyPath);
    expect(daily).toContain('## Heute');
    expect(daily).toContain('<!-- crew:task-triage -->');
    expect(h.snapshot.paths(result.runId)).toContain(dailyPath);
  });
});

describe('executeRun — raw-output artifacts on validation failure (V1 §2.4/§3.4/§9)', () => {
  it('primary invalid AND repair invalid → both raw outputs saved under artifacts/, never registered as writes', async () => {
    const llm = new ScriptLlmClient([{ content: 'kaputt' }, { content: 'immer noch kaputt' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('invalid_output');

    const runDir = `_crews/runs/${result.runId}`;
    expect(await h.vault.read(`${runDir}/artifacts/analyse-1.txt`)).toBe('kaputt');
    expect(await h.vault.read(`${runDir}/artifacts/analyse-2.txt`)).toBe('immer noch kaputt');

    // artifacts are plugin-internal run output, not an LLM vault write: no writes happened,
    // so they cannot have inflated the write register / max_writes — und werden NICHT
    // gesnapshottet (der preWrite-Hook feuert nur für Executor-Writes, nicht für Artefakte).
    expect(result.writes).toBe(0);
    expect(result.undoable).toBe(false);
    expect(h.snapshot.paths(result.runId)).not.toContain(`${runDir}/artifacts/analyse-1.txt`);
    expect(h.snapshot.finalized).toEqual([]); // writes 0 → finalize nie aufgerufen
  });

  it('primary invalid, repair valid → only the primary raw output is saved (no -2 artifact)', async () => {
    const llm = new ScriptLlmClient([{ content: 'kaputt' }, { content: TRIAGE_OK }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    const runDir = `_crews/runs/${result.runId}`;
    expect(await h.vault.read(`${runDir}/artifacts/analyse-1.txt`)).toBe('kaputt');
    await expect(h.vault.read(`${runDir}/artifacts/analyse-2.txt`)).rejects.toThrow();
  });

  it('golden happy path (no validation failure) writes no artifacts at all', async () => {
    const h = await harness();
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    const runDir = `_crews/runs/${result.runId}`;
    const artifactFiles = [...h.vault.files.keys()].filter((p) => p.startsWith(`${runDir}/artifacts/`));
    expect(artifactFiles).toEqual([]);
  });
});

describe('executeRun — snapshot-finalize-failure resilience (M9)', () => {
  it('snapshot.finalize rejects after writes were applied → resolves (never throws), errorKind io, protocolFailure task recorded, run.md/state.json reflect the real final status + writes', async () => {
    const snapshot = new FinalizeFailsSnapshotStore();
    const h = await harness({ snapshot });

    // Awaiting directly (no try/catch) already proves executeRun resolves rather than rejects.
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');        // finalStatus() was computed before the finalize attempt
    expect(result.errorKind).toBe('io');
    expect(result.writes).toBe(1);            // the actual vault write already happened and is not undone
    expect(result.undoable).toBe(true);       // Writes existieren → undo-bar (Pre-Images sind write-ahead da)
    expect(await h.vault.read('10_Aufgaben/a.md')).toContain('priority: mittel');
    expect(h.snapshot.log).toContain(`finalize:reject:${result.runId}`);

    const runDir = `_crews/runs/${result.runId}`;
    const runMd = await h.vault.read(`${runDir}/run.md`);
    expect(runMd).toContain('status: ok');
    expect(runMd).toContain('error_kind: io');

    const state = JSON.parse(await h.vault.read(`${runDir}/state.json`)) as {
      status: string;
      errorKind: string | null;
      writeRegister: string[];
      tasks: { taskId: string; kind: string; status: string; error: { kind: string; message: string } | null }[];
    };
    expect(state.status).toBe('ok');
    expect(state.errorKind).toBe('io');
    expect(state.writeRegister).toEqual(['10_Aufgaben/a.md']);

    const protocolTask = state.tasks.find((t) => t.taskId === 'preflight' && t.error?.kind === 'io');
    expect(protocolTask).toBeDefined();
    expect(protocolTask?.status).toBe('failed');
    expect(protocolTask?.kind).toBe('collector');
    expect(protocolTask?.error?.message).toContain('Snapshot-Finalize fehlgeschlagen');
  });

  it('finalize failure preserves an already-set errorKind rather than overwriting it with io', async () => {
    // write_limit-Lauf: EIN Write (→ finalize läuft) mit bereits gesetztem errorKind.
    const snapshot = new FinalizeFailsSnapshotStore();
    const llm = new ScriptLlmClient([{
      content: '{"items":[{"path":"10_Aufgaben/a.md","set":{"priority":"mittel"}},{"path":"10_Aufgaben/b.md","set":{"priority":"hoch"}}]}',
    }]);
    const teamFm = triageTeamFm({ limits: { max_writes: 1 } });
    const h = await harness({ snapshot, llm, teamFm, files: { '10_Aufgaben/a.md': TASK_NOTE, '10_Aufgaben/b.md': TASK_NOTE } });

    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('write_limit');    // the pre-existing kind wins, not clobbered by the finalize-io path
    expect(result.writes).toBe(1);

    const runDir = `_crews/runs/${result.runId}`;
    const state = JSON.parse(await h.vault.read(`${runDir}/state.json`)) as {
      tasks: { taskId: string; error: { kind: string } | null }[];
    };
    const protocolTask = state.tasks.find((t) => t.taskId === 'preflight' && t.error?.kind === 'io');
    expect(protocolTask).toBeDefined();
  });
});
