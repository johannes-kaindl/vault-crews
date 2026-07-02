// tests/core/orchestrator.test.ts
import { describe, expect, it } from 'vitest';
import { executeRun, type RunDeps } from '../../src/core/orchestrator';
import type { LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo, RunEvent } from '../../src/core/ports';
import type { RunLimits } from '../../src/core/types';
import { expandTarget } from '../../src/core/paths';
import { InMemoryVaultPort, FixtureMetadataPort } from '../helpers/in-memory-vault';
import { FakeClock } from '../helpers/fake-clock';
import { RecorderReporter } from '../helpers/recorder-reporter';
import { RecorderGitPort } from '../helpers/recorder-git';
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
    limits: LIMITS, ...overrides,
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
  git?: RecorderGitPort;
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
  git: RecorderGitPort;
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

  if (opts.seedLock !== undefined) await vault.create('_crews/runs/.lock', opts.seedLock);

  const clock = opts.clock ?? new FakeClock(START_MS);
  const reporter = new RecorderReporter();
  const git = opts.git ?? new RecorderGitPort();
  const llm = opts.llm ?? new ScriptLlmClient([{ content: TRIAGE_OK }]);
  const abort = opts.abort ?? new AbortController().signal;

  const deps: RunDeps = { vault, meta, llm, git, clock, reporter, settings: baseSettings(opts.settings), abort };
  return { vault, meta, clock, reporter, git, llm, deps, teamPath };
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
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string) => void): Promise<LlmStreamResult> {
    this.clock.tick(this.advanceMs);
    onToken(this.content);
    return { content: this.content, thinkTokens: 0, finishReason: 'stop' };
  }
}

class AbortMidStreamLlm implements LlmClient {
  async ping(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string) => void): Promise<LlmStreamResult> {
    onToken('{"it');
    onToken('ems":');
    return { content: '', thinkTokens: 0, finishReason: 'aborted' };
  }
}

describe('executeRun — ok (happy triage path)', () => {
  it('runs collector→llm→actions, commits once, patches the note, emits ordered events', async () => {
    const h = await harness();
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
    expect(result.commitSha).toBe('sha-1');
    expect(result.writes).toBe(1);
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-task-triage$/);

    // git: exactly one status (preflight) + one applyPlan (committing)
    expect(h.git.log).toEqual(['status', 'applyPlan:sha-1']);
    expect(h.git.plans[0]?.paths).toContain('10_Aufgaben/a.md');

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
    expect(runMd).toContain('commit: sha-1');
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
    expect(h.git.log).toContain('applyPlan:sha-1');
  });

  it('repair-fail-abort: invalid twice, on_error abort → failed invalid_output, partial commit', async () => {
    const llm = new ScriptLlmClient([{ content: 'kaputt' }, { content: 'immer noch kaputt' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('invalid_output');
    expect(result.errorTask).toBe('analyse');
    expect(result.writes).toBe(0);
    // always commits (protocol commit), even on failure
    expect(h.git.log).toContain('applyPlan:sha-1');
    expect(result.commitSha).toBe('sha-1');
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
    expect(h.git.log).toContain('applyPlan:sha-1');
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
    expect(h.git.log).toContain('applyPlan:sha-1');
  });

  it('stall → failed with errorKind stalled', async () => {
    const llm = new ScriptLlmClient([{ error: 'stalled' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('stalled');
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

describe('executeRun — abort + watchdog', () => {
  it('abort mid-stream: finishReason aborted → status aborted, partial commit', async () => {
    const h = await harness({ llm: new AbortMidStreamLlm() });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('aborted');
    expect(result.errorKind).toBe('aborted');
    expect(result.errorTask).toBe('analyse');
    expect(h.git.log).toContain('applyPlan:sha-1');
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
    expect(h.git.log).toContain('applyPlan:sha-1');
  });
});

describe('executeRun — executor failures', () => {
  it('write_limit: too many patches → failed write_limit, partial writes committed', async () => {
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
    expect(h.git.log).toContain('applyPlan:sha-1');
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
    expect(h.git.log).toContain('applyPlan:sha-1');
  });
});

describe('executeRun — preflight refusals', () => {
  it('git-refused: not a repo → refused git_refused, NO commit, run.md written', async () => {
    const git = new RecorderGitPort();
    git.statusInfo = { isRepo: false, inMergeOrRebase: false, hasIndexLock: false, headSha: null, dirty: false };
    const h = await harness({ git });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('git_refused');
    expect(result.commitSha).toBeNull();
    expect(h.git.log).toEqual(['status']); // no applyPlan
    const runDir = `_crews/runs/${result.runId}`;
    expect(await h.vault.read(`${runDir}/run.md`)).toContain('status: refused');
  });

  it('git index.lock persists → refused git_refused after 4 status polls (3×2s retry)', async () => {
    const git = new RecorderGitPort();
    git.statusInfo = { isRepo: true, inMergeOrRebase: false, hasIndexLock: true, headSha: 'base', dirty: false };
    const clock = new FakeClock(START_MS);
    const h = await harness({ git, clock });
    const result = await runToCompletion(executeRun(h.teamPath, h.deps), clock);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('git_refused');
    expect(h.git.log.filter((x) => x === 'status')).toHaveLength(4);
  });

  it('endpoint unreachable (no candidates) → refused endpoint_unreachable, git untouched', async () => {
    const h = await harness({ settings: { endpoints: [] } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('endpoint_unreachable');
    expect(h.git.log).toEqual([]); // refused before git check
  });

  it('model missing → refused model_missing', async () => {
    const h = await harness({ settings: { defaultModel: 'ghost-model' } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.errorKind).toBe('model_missing');
    expect(h.git.log).toEqual([]);
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
    expect(h.git.log).toEqual([]);
  });
});

describe('executeRun — run lock', () => {
  it('lock-orphaned: stale lock (older than wallClockMs) → taken over, run proceeds to ok', async () => {
    const seedLock = JSON.stringify({ active: true, runId: 'old-run', startedAt: START_MS - LIMITS.wallClockMs - 1 });
    const h = await harness({ seedLock });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    // lock released (never committed) after the run
    const lock = JSON.parse(await h.vault.read('_crews/runs/.lock')) as { active: boolean };
    expect(lock.active).toBe(false);
  });

  it('active lock (recent) → refused, no commit', async () => {
    const seedLock = JSON.stringify({ active: true, runId: 'other', startedAt: START_MS });
    const h = await harness({ seedLock });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(h.git.log).not.toContain('applyPlan:sha-1');
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
      llm: new ScriptLlmClient([{ content: '{"markdown":"## Heute\\n- Aufgabe X"}' }]),
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(result.writes).toBe(1);
    const daily = await h.vault.read(dailyPath);
    expect(daily).toContain('## Heute');
    expect(daily).toContain('<!-- crew:task-triage -->');
    expect(h.git.plans[0]?.paths).toContain(dailyPath);
  });
});
