// tests/core/orchestrator.test.ts
import { describe, expect, it, vi } from 'vitest';
import { executeRun, type RunDeps } from '../../src/core/orchestrator';
import { LlmCallError } from '../../src/core/ports';
import type { LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo, RunEvent } from '../../src/core/ports';
import type { RunLimits } from '../../src/core/types';
import { expandTarget } from '../../src/core/paths';
import { fnv1a } from '../../src/core/collectors';
import { InMemoryVaultPort, FixtureMetadataPort } from '../helpers/in-memory-vault';
import { FakeClock } from '../helpers/fake-clock';
import { RecorderReporter } from '../helpers/recorder-reporter';
import { FakeSnapshotStore, FinalizeFailsSnapshotStore } from '../helpers/fake-snapshot';
import { ScriptLlmClient, type ScriptedCall } from '../helpers/script-llm';
import { fakeRequestPort, type FakeRequestPort } from '../helpers/fake-request-port';
import { DEFAULT_REQUEST_SETTINGS } from '../../src/vendor/kit/sampling-profiles';

// Schalter für den fail-closed-Wurf der Kit-Schwärzung (siehe Test „Schwärzung wirft“).
const redactSwitch = vi.hoisted(() => ({ throwAfter: null as number | null, calls: 0 }));
vi.mock('../../src/vendor/kit/redact', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/vendor/kit/redact')>();
  return {
    ...orig,
    redactKeysInValue: ((...args: Parameters<typeof orig.redactKeysInValue>) => {
      redactSwitch.calls++;
      if (redactSwitch.throwAfter !== null && redactSwitch.calls > redactSwitch.throwAfter) {
        throw new TypeError('redactKeysInValue: the value has no JSON form');
      }
      return orig.redactKeysInValue(...args);
    }) as typeof orig.redactKeysInValue,
  };
});

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
    crewRoot: '_crews', configDir: '.obsidian',
    endpoints: [{ url: 'http://localhost:1234', model: 'test-model' }], deniedEndpoints: [],
    limits: LIMITS, undoHistoryDepth: 15, request: DEFAULT_REQUEST_SETTINGS, ...overrides,
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
  request?: FakeRequestPort;
  seedLock?: string;
}

interface Harness {
  vault: InMemoryVaultPort;
  meta: FixtureMetadataPort;
  clock: FakeClock;
  reporter: RecorderReporter;
  snapshot: FakeSnapshotStore;
  llm: LlmClient;
  request: FakeRequestPort;
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

  const request = opts.request ?? fakeRequestPort();
  const deps: RunDeps = { vault, meta, llm, request, snapshot, clock, reporter, settings: baseSettings(opts.settings), abort };
  return { vault, meta, clock, reporter, snapshot, llm, request, deps, teamPath };
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
  setEndpoint(): void { /* single-endpoint test double: no-op */ }
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string, isThink: boolean) => void): Promise<LlmStreamResult> {
    this.clock.tick(this.advanceMs);
    onToken('reasoning-bit', true);
    onToken(this.content, false);
    return { content: this.content, thinkTokens: 3, reasoned: true, finishReason: 'stop' };
  }
}

class AbortMidStreamLlm implements LlmClient {
  async ping(): Promise<boolean> { return true; }
  setEndpoint(): void { /* single-endpoint test double: no-op */ }
  async listModels(): Promise<string[]> { return ['test-model']; }
  async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: 8192 }; }
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string, isThink: boolean) => void): Promise<LlmStreamResult> {
    onToken('{"it', false);
    onToken('ems":', false);
    return { content: '', thinkTokens: 0, reasoned: false, finishReason: 'aborted' };
  }
}

describe('executeRun — eindeutige Lauf-Id', () => {
  it('gibt zwei Läufen derselben Crew in derselben Sekunde verschiedene Lauf-Ids', async () => {
    const h = await harness({ llm: new ScriptLlmClient([{ content: TRIAGE_OK }, { content: TRIAGE_OK }]) });
    const first = await executeRun(h.teamPath, h.deps);
    const second = await executeRun(h.teamPath, h.deps); // Uhr steht
    expect(first.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-task-triage$/);
    expect(second.runId).toBe(`${first.runId}-2`);
    expect(await h.vault.exists(`_crews/runs/${second.runId}/state.json`)).toBe(true);
  });

  it('zählt weiter hoch (-3), wenn auch -2 belegt ist', async () => {
    const h = await harness({ llm: new ScriptLlmClient([{ content: TRIAGE_OK }, { content: TRIAGE_OK }, { content: TRIAGE_OK }]) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await executeRun(h.teamPath, h.deps)).runId);
    expect(ids[1]).toBe(`${ids[0]}-2`);
    expect(ids[2]).toBe(`${ids[0]}-3`);
  });

  it('die Sperrdatei trägt die endgültige Lauf-Id, auch wenn die Vorab-Id belegt war', async () => {
    const h = await harness();
    // Lauf-Ordner der Vorab-Id ist belegt (state.json), die Sperre liegt noch nicht.
    const pre = await executeRun(h.teamPath, { ...h.deps, llm: new ScriptLlmClient([{ content: TRIAGE_OK }]) });
    const lockSeen: string[] = [];
    const origCreate = h.vault.create.bind(h.vault);
    const origModify = h.vault.modify.bind(h.vault);
    h.vault.create = async (path: string, content: string) => { if (path.endsWith('run-lock.json')) lockSeen.push(content); return origCreate(path, content); };
    h.vault.modify = async (path: string, content: string) => { if (path.endsWith('run-lock.json')) lockSeen.push(content); return origModify(path, content); };
    const second = await executeRun(h.teamPath, { ...h.deps, llm: new ScriptLlmClient([{ content: TRIAGE_OK }]) });
    expect(second.runId).toBe(`${pre.runId}-2`);
    const active = lockSeen.map((c) => JSON.parse(c) as { active: boolean; runId: string }).filter((l) => l.active);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((l) => l.runId === second.runId)).toBe(true);
  });
});

describe('executeRun — ok (happy triage path)', () => {
  it('runs collector→llm→actions, commits once, patches the note, emits ordered events', async () => {
    const h = await harness();
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
    expect(result.undoable).toBe(true);
    expect(result.writes).toBe(1);
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-task-triage$/);
  });

  it('Run-Id trägt den LOKALEN Tag und die lokale Uhrzeit (YYYY-MM-DD-HHmmss-<team>)', async () => {
    const h = await harness({ clock: new FakeClock(new Date(2026, 9, 3, 0, 5).getTime()) });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.runId).toBe('2026-10-03-000500-task-triage');

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

describe('executeRun — token streaming', () => {
  it('emits token events carrying text and correct isThink end-to-end', async () => {
    const clock = new FakeClock(START_MS);
    const h = await harness({ clock, llm: new ClockAdvancingLlm(clock, 0) });
    await executeRun(h.teamPath, h.deps);

    const tokens = h.reporter.events.filter((e): e is Extract<RunEvent, { type: 'token' }> => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((e) => e.isThink === true && e.text === 'reasoning-bit')).toBe(true);
    expect(tokens.some((e) => e.isThink === false && e.text.length > 0)).toBe(true);
  });
});

describe('executeRun — Gemma 4 Denkkanal (Welle 23)', () => {
  it('Familie gemma4: thinkChannel geht an den Client, das Zurücksetzen wird als contentReset-Ereignis gemeldet', async () => {
    const llm = new ScriptLlmClient([{ content: `Ich denke.<channel|>${TRIAGE_OK}`, resetAfterChars: 'Ich denke.'.length, facts: { status: 200, finishReason: 'stop', content: TRIAGE_OK, reasoning: 'Ich denke.' } }]);
    const h = await harness({ llm, request: fakeRequestPort({ family: 'gemma4', backend: 'lmstudio' }) });
    await executeRun(h.teamPath, h.deps);
    expect((h.llm as ScriptLlmClient).calls[0]!.params.thinkChannel).toBe(true);
    const resets = h.reporter.events.filter((e) => e.type === 'contentReset');
    expect(resets).toHaveLength(1);
    // Die Prüfung der Antwort kennt das Backend: Gemma auf LM Studio kann nicht aus, ihr Denken bei „off“ ist keine Abweichung.
    expect(h.request.reported.flat().map((d) => d.kind)).not.toContain('thinking-despite-off');
  });

  it('andere Familien: thinkChannel ist aus, kein contentReset', async () => {
    const h = await harness({ request: fakeRequestPort({ family: 'qwen3.8', backend: 'lmstudio' }) });
    await executeRun(h.teamPath, h.deps);
    expect((h.llm as ScriptLlmClient).calls[0]!.params.thinkChannel).toBe(false);
    expect(h.reporter.events.some((e) => e.type === 'contentReset')).toBe(false);
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

  it('der Reparatur-Call trägt die History: Ausgangs-Prompt, schlechte Antwort, Grund und Aufforderung (Befund „Reparatur-Call ohne Ausgangs-Prompt“)', async () => {
    const llm = new ScriptLlmClient([{ content: 'kein json' }, { content: TRIAGE_OK }]);
    const h = await harness({ llm });
    await executeRun(h.teamPath, h.deps);
    const [first, second] = llm.calls;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const n = first!.messages.length;
    // Der Ausgangs-Prompt (System mit Schema und Format, Nutzer mit Material) steht unverändert am Anfang ...
    expect(second!.messages.slice(0, n)).toEqual(first!.messages);
    // ... danach die schlechte Antwort als Zug des Modells und eine Nutzer-Nachricht mit dem Grund.
    expect(second!.messages[n]).toEqual({ role: 'assistant', content: 'kein json' });
    expect(second!.messages).toHaveLength(n + 2);
    const last = second!.messages[n + 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/was not valid: - /);
    expect(last.content.endsWith('Antworte erneut, exakt in dem im System-Prompt geforderten Format.')).toBe(true);
    expect(last.content).not.toContain('im im');
  });

  it('nach einem Overflow trägt der Reparatur-Call die verkleinerte Fassung, die durchging — nicht die große, die überlief', async () => {
    // Zwei LLM-Tasks heben das Call-Limit auf vier; der zweite Task läuft nur mit, damit Platz für Overflow, Antwort und Reparatur bleibt.
    const teamFm = triageTeamFm({
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['10_Aufgaben/a.md', ...Array.from({ length: 12 }, (_, i) => `10_Aufgaben/b${i}.md`)] } },
        { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1', on_error: 'abort' },
        { id: 'zweit', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte nochmal.', output_schema: 'triage-v1', on_error: 'skip' },
        { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
      ],
    });
    const llm = new ScriptLlmClient([{ error: 'overflow' }, { content: 'kein json' }, { content: TRIAGE_OK }, { content: TRIAGE_OK }]);
    // Genug Material, dass die halbe Budget-Fassung wirklich weniger Einträge trägt (Notizen à 1 200 Zeichen, zusammen mehr als das halbe Budget).
    const files: Record<string, string> = { '10_Aufgaben/a.md': TASK_NOTE };
    for (let i = 0; i < 12; i++) files[`10_Aufgaben/b${i}.md`] = `---\npriority: 1\n---\n${'x'.repeat(1200)}\n`;
    const h = await harness({ llm, teamFm, files });
    await executeRun(h.teamPath, h.deps);
    const [big, halved, repair] = llm.calls;
    expect(repair).toBeDefined();
    expect(halved!.messages).not.toEqual(big!.messages);   // der Overflow hat das Material wirklich verkleinert (sonst beweist der Test nichts)
    expect(repair!.messages.slice(0, halved!.messages.length)).toEqual(halved!.messages);
  });

  it('beim erreichten Call-Limit gibt es keine Reparatur-Runde: invalid_output wie bisher', async () => {
    // Das Limit ist zwei Calls je LLM-Task; der Overflow-Versuch zählt mit, die Reparatur wäre der dritte.
    const llm = new ScriptLlmClient([{ error: 'overflow' }, { content: 'kein json' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('invalid_output');
    expect(llm.calls).toHaveLength(2);
  });

  it('ein Fehler im Reparatur-Call (Server) bleibt ein Fehler dieser Klasse, kein invalid_output', async () => {
    const llm = new ScriptLlmClient([{ content: 'kein json' }, { error: 'http', httpDetail: { status: 500, detail: 'kaputt' } }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('endpoint_error');
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

  it('truncated: finishReason length + ungueltiges JSON → failed output_truncated OHNE Repair-Runde', async () => {
    // Ein Repair gegen dasselbe max_tokens trifft dieselbe Grenze — der Call waere verbrannt.
    const llm = new ScriptLlmClient([{ content: '{"items": [{"id": "a.md", "prio', finishReason: 'length' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('output_truncated');
    expect(result.errorTask).toBe('analyse');
    expect(llm.calls).toHaveLength(1);
  });

  it('truncated: der abgeschnittene Rohtext bleibt als Artifact lesbar', async () => {
    const llm = new ScriptLlmClient([{ content: '{"items": [{"id": "a.md", "prio', finishReason: 'length' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(await h.vault.read(`_crews/runs/${result.runId}/artifacts/analyse-1.txt`)).toBe('{"items": [{"id": "a.md", "prio');
  });

  it('truncated, aber gueltig: length mit vollstaendigem JSON bleibt ok — abgeschnitten ist nicht automatisch kaputt', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, finishReason: 'length' }]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
  });

  it('truncated im Repair: erste Antwort nur kaputt, die Reparatur laeuft ins Limit → output_truncated', async () => {
    const llm = new ScriptLlmClient([
      { content: 'kein json' },
      { content: '{"items": [{"id": "a.md", "prio', finishReason: 'length' },
    ]);
    const h = await harness({ llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('output_truncated');
    expect(llm.calls).toHaveLength(2);
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

describe('executeRun — leerer Collector', () => {
  it('meldet einen Collector ohne Treffer als eigene Ursache, nicht als stilles ok', async () => {
    const llm = new ScriptLlmClient([{ content: '{"items":[]}' }]);
    const h = await harness({ files: {}, llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.emptyCollector).toBe('10_Aufgaben');
    expect(result.status).toBe('partial');
    expect(llm.calls).toHaveLength(0);   // kein Modellaufruf auf leerem Kontext
    const runMd = await h.vault.read(`_crews/runs/${result.runId}/run.md`);
    expect(runMd).toContain('Collector fand 0 passende Notizen in `10_Aufgaben`');
    expect(runMd).toContain('Übersprungen: Collector fand 0 passende Notizen in 10_Aufgaben — Task nicht gestartet');
  });

  it('meldet bei Treffern keine leere Quelle', async () => {
    const h = await harness();
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.emptyCollector).toBeNull();
    const runMd = await h.vault.read(`_crews/runs/${result.runId}/run.md`);
    expect(runMd).toContain('Gefunden: 1 Notiz(en) in `10_Aufgaben`');
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

  it('thinking on + Reasoning → alwaysOnThinker false (Denken wurde gerade bestellt)', async () => {
    // Beweist, dass die Stufe off load-bearing ist: bei bestelltem Denken ist Reasoning erwartet,
    // keine Suppressions-Lücke → Flag bleibt false.
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: true }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'on' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.alwaysOnThinker).toBe(false);
  });

  it('thinking auto + Reasoning → alwaysOnThinker TRUE: auto heißt seit 0.13.0 „Modusvorgabe", und die ist off', async () => {
    // Verhaltensänderung (Welle 14): bis 0.12.0 schickte `auto` nichts und ließ den Server-Standard
    // gelten — Reasoning war dort erwartet. Jetzt bestellt `auto` die Stufe des Modus (structured: off),
    // also ist ein Modell, das trotzdem denkt, eine Suppressions-Lücke.
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: true }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'auto' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.alwaysOnThinker).toBe(true);
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

  it('eine Verweigerung in derselben Sekunde überschreibt den fertigen Lauf derselben Crew nicht', async () => {
    const h = await harness();
    const done = await executeRun(h.teamPath, h.deps);
    expect(done.status).toBe('ok');
    const runMdBefore = await h.vault.read(`_crews/runs/${done.runId}/run.md`);
    const stateBefore = await h.vault.read(`_crews/runs/${done.runId}/state.json`);
    const refused = await executeRun(h.teamPath, { ...h.deps, settings: baseSettings({ endpoints: [] }) }); // Uhr steht
    expect(refused.status).toBe('refused');
    expect(refused.runId).toBe(`${done.runId}-2`);
    expect(await h.vault.read(`_crews/runs/${done.runId}/run.md`)).toBe(runMdBefore);
    expect(await h.vault.read(`_crews/runs/${done.runId}/state.json`)).toBe(stateBefore);
    expect(await h.vault.read(`_crews/runs/${refused.runId}/run.md`)).toContain('status: refused');
  });

  it('Grund des Managers (endpointHint) steht im Protokoll der Verweigerung', async () => {
    const h = await harness({ settings: { endpoints: [], endpointHint: 'secret-missing' } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.errorKind).toBe('endpoint_unreachable');
    const runMd = await h.vault.read(`_crews/runs/${result.runId}/run.md`);
    expect(runMd).toContain('Kein erreichbarer LLM-Endpoint (secret-missing)');
  });

  it('model missing → refused model_missing', async () => {
    const h = await harness({ settings: { endpoints: [{ url: 'http://localhost:1234', model: 'ghost-model' }] } });
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

describe('executeRun — Sperrliste und Schluessel-Redaction', () => {
  it('filtert einen gesperrten Endpunkt heraus, auch wenn er als Eintrag mit Schluessel steht', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK }]);
    const h = await harness({
      llm,
      settings: {
        endpoints: [
          { url: 'http://localhost:8080', apiKey: 'k', model: 'test-model' },
          { url: 'http://localhost:1234', model: 'test-model' },
        ],
        deniedEndpoints: ['http://localhost:8080'],
      },
    });

    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    // Der gesperrte Port ist nie angesprochen worden — die Sperre wirkt auf die URL des
    // Eintrags, nicht mehr auf einen blanken String.
    expect(llm.baseCalls).toEqual(['http://localhost:1234']);
  });

  it('schreibt keinen API-Schluessel ins Run-Log, auch nicht aus einem Fehlerkoerper', async () => {
    // Manche Gateways spiegeln den gesendeten Authorization-Header in ihrer 401-Antwort
    // wider — und ein Vault wird gesynct. Der Fehlertext kommt hier deshalb so herein,
    // wie ihn ein solches Gateway liefern wuerde.
    class LeakyLlm extends ScriptLlmClient {
      async stream(): Promise<never> {
        throw new LlmCallError('HTTP 401: invalid key sk-geheim-1234567890', 'http');
      }
    }
    const h = await harness({
      llm: new LeakyLlm([]),
      settings: {
        endpoints: [{ url: 'http://gw:1', apiKey: 'sk-geheim-1234567890', model: 'test-model' }],
      },
    });

    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('failed');
    const runMd = await h.vault.read(`_crews/runs/${result.runId}/run.md`);
    expect(runMd).not.toContain('sk-geheim-1234567890');
    expect(runMd).toContain('••••');
  });
});

describe('executeRun — erster Lauf in einem Vault ohne Lauf-Ordner (Welle 20)', () => {
  it('legt `<crewRoot>/runs/` selbst an: ohne den Ordner scheiterte der erste Lauf mit io (von Hand angelegte Crews)', async () => {
    const h = await harness();
    // Wie Obsidian: create wirft, wenn der Elternordner fehlt. Es gibt `_crews/teams`, `_crews/agents`, `10_Aufgaben` — aber kein `_crews/runs`.
    h.vault.requireExistingFolders();
    expect(await h.vault.exists('_crews/runs/run-lock.json')).toBe(false);

    const result = await executeRun(h.teamPath, h.deps);

    expect(result.errorKind).toBeNull();
    expect(result.status).toBe('ok');
    expect(await h.vault.exists(`_crews/runs/${result.runId}/run.md`)).toBe(true);
    const lock = JSON.parse(await h.vault.read('_crews/runs/run-lock.json')) as { active: boolean };
    expect(lock.active).toBe(false);
  });

  it('der Ordner darf schon da sein (mkdir ist idempotent): zweiter Lauf hintereinander', async () => {
    const h = await harness({ llm: new ScriptLlmClient([{ content: TRIAGE_OK }, { content: TRIAGE_OK }]) });
    h.vault.requireExistingFolders();
    const a = await executeRun(h.teamPath, h.deps);
    const b = await executeRun(h.teamPath, h.deps);
    expect([a.status, b.status]).toEqual(['ok', 'ok']);
  });
});

describe('executeRun — Schwärzung wirft (fail-closed)', () => {
  it.each([[0, 'beim Öffnen des Laufs'], [1, 'nach dem ersten Task']])(
    'wirft die Schwärzung %i Aufrufe nach dem Start (%s) → Lauf endet failed/io, genau ein runFinished, danach wird nichts mehr geschrieben',
    async (throwAfter) => {
      redactSwitch.calls = 0;
      redactSwitch.throwAfter = throwAfter;
      try {
        const h = await harness();
        const result = await executeRun(h.teamPath, h.deps);

        expect(result.status).toBe('failed');
        expect(result.errorKind).toBe('io');
        expect(h.reporter.events.filter((e) => e.type === 'runFinished')).toHaveLength(1);
        // kein persist() nach dem Wurf: genau so viele Aufrufe wie bis zum Wurf
        expect(redactSwitch.calls).toBe(throwAfter + 1);
        // der Lock ist frei
        const lock = JSON.parse(await h.vault.read('_crews/runs/run-lock.json')) as { active: boolean };
        expect(lock.active).toBe(false);
        // nichts Ungeschwärztes im Vault: ein erstes run.md existiert nur, wenn der Wurf später kam
        const runMd = `_crews/runs/${result.runId}/run.md`;
        if (throwAfter === 0) expect(await h.vault.exists(runMd)).toBe(false);
      } finally {
        redactSwitch.throwAfter = null;
      }
    },
  );
});

describe('executeRun — endpoint failover + preflight crash-safety (review C1)', () => {
  it('failover: endpoints[0] unreachable, endpoints[1] reachable → run succeeds using the reachable endpoint, setEndpoint called before listModels', async () => {
    class FailoverLlmClient extends ScriptLlmClient {
      readonly order: string[] = [];
      async ping(cfg: { url: string }): Promise<boolean> { return cfg.url === 'http://ep2:1234'; }
      setEndpoint(cfg: { url: string }): void { this.order.push(`setEndpoint:${cfg.url}`); super.setEndpoint(cfg); }
      async listModels(): Promise<string[]> { this.order.push('listModels'); return super.listModels(); }
    }
    const llm = new FailoverLlmClient([{ content: TRIAGE_OK }]);
    const h = await harness({ llm, settings: { endpoints: [{ url: 'http://ep1:1234', model: 'test-model' }, { url: 'http://ep2:1234', model: 'test-model' }] } });
    const result = await executeRun(h.teamPath, h.deps);

    expect(result.status).toBe('ok');
    expect(result.errorKind).toBeNull();
    // proves the run actually targeted the reachable failover endpoint, in the right order
    expect(llm.order).toEqual(['setEndpoint:http://ep2:1234', 'listModels']);
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

describe('executeRun — zwei Schritte auf dieselbe Notiz (eigener Schreibstand)', () => {
  const TWO_STEP_TEAM: TeamFm = {
    'crew-kind': 'team', name: 'Task-Triage', version: 1, trigger: 'manual', description: '',
    limits: { max_writes: 5 },
    write_scope: ['10_Aufgaben/**/*.md'],
    tasks: [
      { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
      { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output: { family: 'frontmatter.set', allowed_keys: ['priority'] }, on_error: 'abort' },
      { id: 'apply1', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
      { id: 'brief', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Schreibe.', output: { family: 'section.write' }, on_error: 'abort' },
      { id: 'apply2', kind: 'actions', inputs: ['brief'], allowed_actions: ['section.replace'], allowed_keys: null, target: '10_Aufgaben/a.md' },
    ],
  };

  it('beide actions-Schritte enden mit applied: der Stand des ersten gilt im zweiten nicht als stale', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK }, { content: '## Notiz\n- erledigt' }]);
    const h = await harness({ teamFm: TWO_STEP_TEAM, llm });
    const result = await executeRun(h.teamPath, h.deps);
    const state = JSON.parse(await h.vault.read(`_crews/runs/${result.runId}/state.json`)) as { tasks: { taskId: string; status: string }[] };
    expect(state.tasks.filter((t) => t.taskId.startsWith('apply')).map((t) => [t.taskId, t.status])).toEqual([['apply1', 'ok'], ['apply2', 'ok']]);
    expect(result.status).toBe('ok');
    const note = await h.vault.read('10_Aufgaben/a.md');
    expect(note).toContain('priority: mittel');
    expect(note).toContain('- erledigt');
  });

  it('eine fremde Änderung zwischen den Schritten bleibt stale', async () => {
    class EditingLlm extends ScriptLlmClient {
      constructor(private readonly vaultRef: () => InMemoryVaultPort) { super([{ content: TRIAGE_OK }, { content: '## Notiz\n- erledigt' }]); }
      override async stream(...args: Parameters<ScriptLlmClient['stream']>): ReturnType<ScriptLlmClient['stream']> {
        const r = await super.stream(...args);
        if (this.calls.length === 2) await this.vaultRef().modify('10_Aufgaben/a.md', `${await this.vaultRef().read('10_Aufgaben/a.md')}FREMD\n`);
        return r;
      }
    }
    let vaultRef: InMemoryVaultPort | undefined;
    const llm = new EditingLlm(() => vaultRef as InMemoryVaultPort);
    const h = await harness({ teamFm: TWO_STEP_TEAM, llm });
    vaultRef = h.vault;
    const result = await executeRun(h.teamPath, h.deps);
    const state = JSON.parse(await h.vault.read(`_crews/runs/${result.runId}/state.json`)) as { tasks: { taskId: string; status: string }[] };
    expect(state.tasks.find((t) => t.taskId === 'apply2')?.status).toBe('failed');
    expect(await h.vault.read('10_Aufgaben/a.md')).not.toContain('- erledigt');
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

describe('executeRun — Anfrage-Profil (Modus structured)', () => {
  const call0 = (h: Harness): LlmParams => (h.llm as ScriptLlmClient).calls[0]!.params;

  it('schickt die aufgelösten Parameter: Persona-Temperatur, Budget und Draht-Modell', async () => {
    const h = await harness({
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', temperature: 0.4, max_tokens: 1500 }, body: 'x' } },
    });
    await executeRun(h.teamPath, h.deps);
    expect(call0(h)).toMatchObject({ model: 'test-model', sentModel: 'test-model', thinkingLevel: 'off', params: { temperature: 0.4, max_tokens: 1500 } });
  });

  it('ohne Persona-Temperatur gilt der Profilwert des Modus (0.1), nicht ein Parser-Default', async () => {
    const h = await harness();
    await executeRun(h.teamPath, h.deps);
    expect(call0(h).params.temperature).toBe(0.1);
  });

  it('Familie und Backend kommen aus dem Port und landen im Body: qwen3.8 auf Open WebUI trägt presence_penalty', async () => {
    const request = fakeRequestPort({ family: 'qwen3.8', backend: 'openwebui' });
    const h = await harness({ request });
    await executeRun(h.teamPath, h.deps);
    expect(call0(h).params).toMatchObject({ top_p: 0.8, top_k: 20, presence_penalty: 1.5, reasoning_effort: 'none' });
    // Das Backend wird EINMAL je Lauf erfragt, nach der Endpunktwahl — am Endpunkt, der antwortete.
    expect(request.backendAsked).toEqual(['http://localhost:1234']);
  });

  it('hält jede gesendete Anfrage in der Sitzung fest (Abschnitt „Anfrage": letzte Anfrage)', async () => {
    const h = await harness();
    await executeRun(h.teamPath, h.deps);
    expect(h.request.recorded).toHaveLength(1);
    expect(h.request.recorded[0]).toEqual(call0(h).params);
  });

  it('meldet eine Abweichung, wenn das Modell trotz off gedacht hat', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, facts: { status: 200, finishReason: 'stop', content: TRIAGE_OK, reasoning: 'hmm' } }]);
    const h = await harness({ llm });
    await executeRun(h.teamPath, h.deps);
    expect(h.request.reported.flat().map((d) => d.kind)).toContain('thinking-despite-off');
  });

  it('meldet eine Ablehnung des Servers (HTTP 400) mit Status und Text', async () => {
    const llm = new ScriptLlmClient([{ error: 'http', httpDetail: { status: 400, detail: 'unknown field top_k' } }]);
    const h = await harness({ llm });
    await executeRun(h.teamPath, h.deps);
    expect(h.request.reported.flat()).toEqual([expect.objectContaining({ kind: 'rejected', detail: expect.stringContaining('top_k') })]);
  });

  it('meldet nichts, wenn die Antwort zur Bestellung passt', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, facts: { status: 200, finishReason: 'stop', content: TRIAGE_OK, reasoning: '' } }]);
    const h = await harness({ llm });
    await executeRun(h.teamPath, h.deps);
    expect(h.request.reported.flat()).toEqual([]);
  });
});


// Die Modellanzeige je Crew nennt das Modell des letzten Laufs: RunResult trägt je llm-Task, welches Modell er aufgelöst hat.
describe('executeRun — Modell je llm-Task im Ergebnis', () => {
  const twoLlmTeam = (): TeamFm => triageTeamFm({
    tasks: [
      { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
      { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1', on_error: 'abort' },
      { id: 'zweite', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Nochmal.', output_schema: 'triage-v1', on_error: 'skip' },
      { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
    ],
  });

  it('nennt je gelaufenem llm-Task das aufgelöste Modell, in der Reihenfolge der Crew', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK }, { content: TRIAGE_OK }]);
    const h = await harness({ teamFm: twoLlmTeam(), llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.models).toEqual([{ taskId: 'analyse', model: 'test-model' }, { taskId: 'zweite', model: 'test-model' }]);
  });

  it('lässt einen übersprungenen llm-Task aus (kein erfundener Eintrag)', async () => {
    const llm = new ScriptLlmClient([{ content: '{"items":[]}' }]);
    const h = await harness({ teamFm: twoLlmTeam(), files: {}, llm });
    const result = await executeRun(h.teamPath, h.deps);
    expect(llm.calls).toHaveLength(0);
    expect(result.models).toEqual([]);
  });

  it('ein Lauf, der wegen fehlendem Modell vor dem Start abbricht, nennt keins', async () => {
    const h = await harness({ settings: { endpoints: [{ url: 'http://localhost:1234' }] } });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('refused');
    expect(result.models).toEqual([]);
  });
});

// ── Wertemengen aus dem Bestand (values) und Hinzufügen (add_to) ─────────────

describe('executeRun — values und add_to', () => {
  const NOTE_A = '---\ntags:\n  - alt\n---\nInhalt\n';
  const NOTE_Z = '---\ntags:\n  - projekt/alpha\n---\nAnderes\n';

  function valuesTeam(output: Record<string, unknown>): TeamFm {
    return triageTeamFm({
      write_scope: ['n/**/*.md'],
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['n/a.md'] } },
        { id: 'tag', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Vergib Tags.', output, on_error: 'abort' },
        { id: 'apply', kind: 'actions', inputs: ['tag'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['tags', 'type'] },
      ],
    });
  }
  const answer = (tags: unknown): ScriptedCall => ({ content: JSON.stringify({ items: [{ path: 'n/a.md', set: { tags } }] }) });

  it('add_to ergänzt die Tags der Notiz um einen Tag aus dem Bestand, die alten bleiben', async () => {
    const llm = new ScriptLlmClient([answer(['projekt-alpha'])]);
    const h = await harness({
      teamFm: valuesTeam({ family: 'frontmatter.set', allowed_keys: ['tags'], values: { tags: { from: 'tags' } }, add_to: ['tags'] }),
      files: { 'n/a.md': NOTE_A, 'n/z.md': NOTE_Z }, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const after = await h.vault.read('n/a.md');
    expect(after).toContain('- alt');
    expect(after).toContain('- projekt/alpha');
    // Der Prompt nennt die Kurzformen der Bestands-Tags, nicht die Originale.
    expect(llm.calls[0]?.messages[0]?.content).toContain('Erlaubte Werte für tags: alt, projekt-alpha');
  });

  it('ohne add_to ersetzt der Wert die Tags wie bisher', async () => {
    const llm = new ScriptLlmClient([answer(['projekt-alpha'])]);
    const h = await harness({
      teamFm: valuesTeam({ family: 'frontmatter.set', allowed_keys: ['tags'], values: { tags: { from: 'tags' } } }),
      files: { 'n/a.md': NOTE_A, 'n/z.md': NOTE_Z }, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const after = await h.vault.read('n/a.md');
    expect(after).toContain('- projekt/alpha');
    expect(after).not.toContain('- alt');
  });

  it('ein Tag, den es im Vault nicht gibt, wird abgelehnt: kein Schreibvorgang', async () => {
    const llm = new ScriptLlmClient([answer(['erfunden']), answer(['erfunden'])]);
    const h = await harness({
      teamFm: valuesTeam({ family: 'frontmatter.set', allowed_keys: ['tags'], values: { tags: { from: 'tags' } }, add_to: ['tags'] }),
      files: { 'n/a.md': NOTE_A, 'n/z.md': NOTE_Z }, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('invalid_output');
    expect(r.writes).toBe(0);
    expect(await h.vault.read('n/a.md')).toBe(NOTE_A);
  });

  it('die Wertemenge aus values ersetzt die aus den Eingaben und gilt im Aktions-Schritt (Rück-Mapping auf den Originalwert)', async () => {
    const note = '---\ntype: 1_alt_🟢\n---\nInhalt\n';
    const llm = new ScriptLlmClient([{ content: JSON.stringify({ items: [{ path: 'n/a.md', set: { type: 'aufgabe' } }] }) }]);
    const h = await harness({
      teamFm: valuesTeam({ family: 'frontmatter.set', allowed_keys: ['type'], values: { type: { from: 'list', list: ['Notiz', 'Aufgabe'] } } }),
      files: { 'n/a.md': note }, llm,
    });
    // Die Eingabe trägt für `type` eine Enum-Tabelle (1_alt_🟢 → alt); values verdrängt sie.
    const sys = (): string => llm.calls[0]?.messages[0]?.content ?? '';
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(sys()).toContain('Erlaubte Werte für type: aufgabe, notiz');
    expect(sys()).not.toContain('alt');
    expect(await h.vault.read('n/a.md')).toContain('type: Aufgabe');
  });

  it('schreibt die Klartextzeilen zu den Wertemengen in state.json und run.md', async () => {
    const llm = new ScriptLlmClient([{ content: JSON.stringify({ items: [{ path: 'n/a.md', set: { type: 'notiz' } }] }) }]);
    const h = await harness({
      teamFm: valuesTeam({ family: 'frontmatter.set', allowed_keys: ['type'], values: { type: { from: 'list', list: ['🙂', 'Notiz'] } } }),
      files: { 'n/a.md': NOTE_A }, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const state = JSON.parse(await h.vault.read(`_crews/runs/${r.runId}/state.json`)) as { tasks: { taskId: string; valueNotes?: string[] }[] };
    expect(state.tasks.find((t) => t.taskId === 'tag')?.valueNotes?.join('\n')).toContain('🙂');
    expect(state.tasks.find((t) => t.taskId === 'collect')?.valueNotes).toBeUndefined();
    const runMd = await h.vault.read(`_crews/runs/${r.runId}/run.md`);
    expect(runMd).toMatch(/values\.type: „🙂“ hat keine brauchbare Kurzform/);
  });

  it('bei per_note gilt die Wertemenge für jede Notiz und wird einmal aufgelöst', async () => {
    const team = valuesTeam({ family: 'frontmatter.set', allowed_keys: ['tags'], values: { tags: { from: 'tags' } }, add_to: ['tags'] });
    (team.tasks as Record<string, unknown>[])[0] = { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: ['n/a.md', 'n/b.md'] } };
    (team.tasks as Record<string, unknown>[])[1] = { ...(team.tasks as Record<string, unknown>[])[1], per_note: true };
    const mk = (p: string): ScriptedCall => ({ content: JSON.stringify({ items: [{ path: p, set: { tags: ['projekt-alpha'] } }] }) });
    const llm = new ScriptLlmClient([mk('n/a.md'), mk('n/b.md')]);
    const h = await harness({ teamFm: team, files: { 'n/a.md': NOTE_A, 'n/b.md': NOTE_A, 'n/z.md': NOTE_Z }, llm });
    let tagCalls = 0;
    const orig = h.meta.listTags.bind(h.meta);
    h.meta.listTags = async () => { tagCalls++; return orig(); };
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(tagCalls).toBe(1);
    expect(llm.calls.every((c) => (c.messages[0]?.content ?? '').includes('Erlaubte Werte für tags: alt, projekt-alpha'))).toBe(true);
    expect(await h.vault.read('n/b.md')).toContain('- projekt/alpha');
  });
});

// ── per_note: ein Modellaufruf je Notiz ──────────────────────────────────────

const PN_NOTE = '---\npriority: niedrig\n---\nInhalt\n';
const INVALID: ScriptedCall = { content: 'kein JSON, nur Prosa' };

function okFor(path: string): ScriptedCall {
  return { content: JSON.stringify({ items: [{ path, set: { priority: 'mittel' } }] }) };
}

function perNoteTeam(paths: string[], o: { onError?: 'abort' | 'skip'; maxWrites?: number } = {}): TeamFm {
  return triageTeamFm({
    limits: { max_writes: o.maxWrites ?? 10 },
    write_scope: ['n/**/*.md'],
    tasks: [
      { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths } },
      { id: 'tag', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte die Notiz.', output_schema: 'triage-v1', per_note: true, on_error: o.onError ?? 'abort' },
      { id: 'apply', kind: 'actions', inputs: ['tag'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
    ],
  });
}

function pnFiles(paths: string[], body = PN_NOTE): Record<string, string> {
  return Object.fromEntries(paths.map((p) => [p, body]));
}

interface PnState {
  tasks: { taskId: string; status: string; promptHash: string | null; error: { kind: string; message: string } | null; skipReason?: string; artifactJson?: unknown;
    notes?: { path: string; status: string; reason: string | null; truncated: { shown: number; total: number } | null }[] }[];
}
async function stateOf(h: Harness, runId: string): Promise<PnState> {
  return JSON.parse(await h.vault.read(`_crews/runs/${runId}/state.json`)) as PnState;
}
async function tagRecord(h: Harness, runId: string): Promise<PnState['tasks'][number]> {
  const rec = (await stateOf(h, runId)).tasks.find((t) => t.taskId === 'tag');
  if (rec === undefined) throw new Error('Task tag fehlt im Zustand');
  return rec;
}

describe('executeRun — per_note', () => {
  const NOTES = ['n/a.md', 'n/b.md', 'n/c.md'];

  it('ruft das Modell je Notiz einmal, jeder Prompt enthält genau eine Notiz', async () => {
    const llm = new ScriptLlmClient(NOTES.map(okFor));
    const h = await harness({ teamFm: perNoteTeam(NOTES), files: pnFiles(NOTES), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls.map((c) => (c.messages[1]?.content.match(/"path":"n\/[abc]\.md"/g) ?? []).length)).toEqual([1, 1, 1]);
    expect(r.status).toBe('ok');
    const started = h.reporter.events.filter((e): e is Extract<RunEvent, { type: 'noteStarted' }> => e.type === 'noteStarted');
    expect(started.map((e) => [e.taskId, e.index, e.total, e.path])).toEqual([
      ['tag', 1, 3, 'n/a.md'], ['tag', 2, 3, 'n/b.md'], ['tag', 3, 3, 'n/c.md'],
    ]);
    // Die Aktionen aller Notizen bilden das Artefakt: der Aktions-Schritt schreibt alle drei.
    for (const p of NOTES) expect(await h.vault.read(p)).toContain('mittel');
    const rec = await tagRecord(h, r.runId);
    expect(rec.notes?.map((n) => [n.path, n.status])).toEqual(NOTES.map((p) => [p, 'ok']));
    expect(rec.artifactJson).toMatchObject({ output: [expect.anything(), expect.anything(), expect.anything()] });
    expect(rec.promptHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('der Prompt-Hash des Schritts ist fnv1a über die Hashes der Einzelaufrufe', async () => {
    // Mit einer Notiz ist der Einzelaufruf derselbe Prompt wie ohne per_note: dessen Hash ist der Einzelhash.
    const plainTeam = perNoteTeam(['n/a.md']);
    (plainTeam.tasks as Record<string, unknown>[])[1] = { ...(plainTeam.tasks as Record<string, unknown>[])[1], per_note: false };
    const plain = await harness({ teamFm: plainTeam, files: pnFiles(['n/a.md']), llm: new ScriptLlmClient([okFor('n/a.md')]) });
    const rp = await runToCompletion(executeRun(plain.teamPath, plain.deps), plain.clock);
    const single = (await tagRecord(plain, rp.runId)).promptHash ?? '';
    expect(single).toMatch(/^[0-9a-f]{8}$/);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md']), files: pnFiles(['n/a.md']), llm: new ScriptLlmClient([okFor('n/a.md')]) });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect((await tagRecord(h, r.runId)).promptHash).toBe(fnv1a(single));
  });

  it('legt die Rohantworten je Notiz in eigene Dateien', async () => {
    const llm = new ScriptLlmClient([INVALID, INVALID, INVALID, INVALID]);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md', 'n/b.md'], { onError: 'skip' }), files: pnFiles(['n/a.md', 'n/b.md']), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    for (const f of ['tag-n1-1.txt', 'tag-n1-2.txt', 'tag-n2-1.txt', 'tag-n2-2.txt']) {
      expect(await h.vault.exists(`_crews/runs/${r.runId}/artifacts/${f}`), f).toBe(true);
    }
  });

  it('überspringt mit on_error: skip die eine Notiz und endet als partial', async () => {
    const llm = new ScriptLlmClient([INVALID, INVALID, okFor('n/b.md')]);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md', 'n/b.md'], { onError: 'skip' }), files: pnFiles(['n/a.md', 'n/b.md']), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('partial');
    const rec = await tagRecord(h, r.runId);
    expect(rec.status).toBe('ok');
    expect(rec.notes?.map((n) => n.status)).toEqual(['failed', 'ok']);
    expect(rec.notes?.[0]?.reason).toBeTruthy();
    expect(await h.vault.read('n/b.md')).toContain('mittel');
    expect(await h.vault.read('n/a.md')).not.toContain('mittel');
  });

  it('verarbeitet höchstens 20 Notizen und nennt die übrigen', async () => {
    const paths = Array.from({ length: 21 }, (_, i) => `n/${String(i).padStart(2, '0')}.md`);
    const llm = new ScriptLlmClient(paths.slice(0, 20).map(okFor));
    const h = await harness({
      teamFm: perNoteTeam(paths, { maxWrites: 20 }), files: pnFiles(paths), llm,
      settings: { limits: { ...LIMITS, maxWrites: 25 } },
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(20);
    expect((await tagRecord(h, r.runId)).notes?.[20]).toMatchObject({ path: 'n/20.md', status: 'skipped' });
    expect(r.status).toBe('partial');
    expect(r.writes).toBe(20);
  });

  it('on_error: abort bricht bei der ersten gescheiterten Notiz den Lauf ab', async () => {
    const llm = new ScriptLlmClient([INVALID, INVALID, okFor('n/b.md')]);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md', 'n/b.md']), files: pnFiles(['n/a.md', 'n/b.md']), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('failed');
    expect(r.errorTask).toBe('tag');
    expect(r.errorKind).toBe('invalid_output');
    expect(llm.calls).toHaveLength(2);
    const rec = await tagRecord(h, r.runId);
    expect(rec.status).toBe('failed');
    expect(rec.notes?.map((n) => n.status)).toEqual(['failed', 'skipped']);
  });

  it('vermerkt eine über 32 768 Zeichen gekürzte Notiz im NoteRecord', async () => {
    const big = `${PN_NOTE}${'y'.repeat(40_000)}`;
    const llm = new ScriptLlmClient([okFor('n/a.md')], 200_000);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md']), files: { 'n/a.md': big }, llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect((await tagRecord(h, r.runId)).notes?.[0]?.truncated).toEqual({ shown: 32_768, total: big.length });
    const runMd = await h.vault.read(`_crews/runs/${r.runId}/run.md`);
    expect(runMd).toContain('n/a.md');
    expect(runMd).toContain(`gekürzt gelesen (32 768 von ${String(big.length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Zeichen)`);
  });

  it('schickt eine Notiz, die allein nicht ins Kontextbudget passt, nicht an das Modell (on_error: abort)', async () => {
    const llm = new ScriptLlmClient([okFor('n/a.md')]); // Kontext 8192: 30 000 Zeichen passen nicht
    const h = await harness({ teamFm: perNoteTeam(['n/a.md']), files: { 'n/a.md': `${PN_NOTE}${'y'.repeat(30_000)}` }, llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(0);
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('context_overflow');
    const rec = await tagRecord(h, r.runId);
    expect(rec.notes?.[0]).toMatchObject({ path: 'n/a.md', status: 'failed' });
    expect(rec.notes?.[0]?.reason).toMatch(/budget/i);
  });

  it('enden alle Notizen als failed mit on_error: skip, ist der Schritt skipped und der Lauf partial', async () => {
    const llm = new ScriptLlmClient([okFor('n/a.md')]);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md'], { onError: 'skip' }), files: { 'n/a.md': `${PN_NOTE}${'y'.repeat(30_000)}` }, llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(0);
    expect(r.status).toBe('partial');
    const state = await stateOf(h, r.runId);
    expect(state.tasks.find((t) => t.taskId === 'tag')?.status).toBe('skipped');
    expect(state.tasks.find((t) => t.taskId === 'apply')?.status).toBe('skipped');
    expect(r.writes).toBe(0);
  });

  it('eine wegen der Gesamtkappung nicht gelesene Notiz (shown 0) ist ein Fehler dieser Notiz', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `n/${i}.md`);
    const llm = new ScriptLlmClient(paths.slice(0, 8).map(okFor), 200_000);
    const h = await harness({ teamFm: perNoteTeam(paths, { onError: 'skip' }), files: pnFiles(paths, 'z'.repeat(32_768)), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(8);
    const rec = await tagRecord(h, r.runId);
    expect(rec.notes?.[8]).toMatchObject({ path: 'n/8.md', status: 'failed', truncated: { shown: 0, total: 32_768 } });
    expect(rec.notes?.[8]?.reason).toMatch(/262144|Gesamt/);
    expect(r.status).toBe('partial');
  });

  it('läuft die Wanduhr mitten im Schritt ab, endet der Lauf als failed und die Meldung nennt die Einstellung', async () => {
    const clock = new FakeClock(START_MS);
    const llm = new ClockAdvancingLlm(clock, 700_000, okFor('n/a.md').content);
    const h = await harness({ teamFm: perNoteTeam(['n/a.md', 'n/b.md']), files: pnFiles(['n/a.md', 'n/b.md']), llm, clock });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('timeout');
    expect(r.errorTask).toBe('tag');
    const rec = await tagRecord(h, r.runId);
    expect(rec.status).toBe('failed');
    expect(rec.error?.kind).toBe('timeout');
    expect(rec.error?.message).toMatch(/Zeitlimit \(Minuten\)/);
    expect(rec.notes?.map((n) => n.status)).toEqual(['ok', 'skipped']);
  });

  it('Nutzerabbruch mitten im Schritt: Lauf aborted, die übrigen Notizen stehen als skipped, kein weiterer Aufruf', async () => {
    const ctrl = new AbortController();
    class AbortAfterFirst extends ScriptLlmClient {
      async stream(...args: Parameters<ScriptLlmClient['stream']>): ReturnType<ScriptLlmClient['stream']> {
        const r = await super.stream(...args);
        ctrl.abort();
        return r;
      }
    }
    const llm = new AbortAfterFirst(NOTES.map(okFor));
    const h = await harness({ teamFm: perNoteTeam(NOTES), files: pnFiles(NOTES), llm, abort: ctrl.signal });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('aborted');
    expect(r.errorKind).toBe('aborted');
    expect(llm.calls).toHaveLength(1);
    const rec = await tagRecord(h, r.runId);
    expect(rec.notes?.map((n) => n.status)).toEqual(['ok', 'skipped', 'skipped']);
    expect(rec.status).toBe('failed');
  });

  it('schwärzt einen API-Schlüssel aus der Fehlermeldung auch im Grund der Notiz (state.json und run.md)', async () => {
    const KEY = 'sk-geheim-1234567890';
    class LeakyLlm extends ScriptLlmClient {
      async stream(): Promise<never> {
        throw new LlmCallError(`HTTP 401: invalid key ${KEY}`, 'http');
      }
    }
    const h = await harness({
      teamFm: perNoteTeam(['n/a.md'], { onError: 'skip' }), files: pnFiles(['n/a.md']), llm: new LeakyLlm([]),
      settings: { endpoints: [{ url: 'http://gw:1', apiKey: KEY, model: 'test-model' }] },
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    const rec = await tagRecord(h, r.runId);
    expect(rec.notes?.[0]?.status).toBe('failed');
    expect(rec.notes?.[0]?.reason).toContain('••••');
    expect(rec.notes?.[0]?.reason).not.toContain(KEY);
    expect(await h.vault.read(`_crews/runs/${r.runId}/state.json`)).not.toContain(KEY);
    expect(await h.vault.read(`_crews/runs/${r.runId}/run.md`)).not.toContain(KEY);
  });

  it('ohne per_note bleibt es bei einem Aufruf und ohne notes im Protokoll', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK }]);
    const h = await harness({ llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(1);
    expect(h.reporter.events.some((e) => e.type === 'noteStarted')).toBe(false);
    expect((await stateOf(h, r.runId)).tasks.every((t) => t.notes === undefined)).toBe(true);
  });
});

describe('executeRun — per_note mit Ziel {{input}}', () => {
  function inputTeam(paths: string[], output: Record<string, unknown>, action: 'section.replace' | 'note.append'): TeamFm {
    return triageTeamFm({
      limits: { max_writes: 10 },
      write_scope: ['n/**/*.md'],
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths } },
        { id: 'tag', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Fasse die Notiz zusammen.', output, per_note: true, on_error: 'abort' },
        { id: 'apply', kind: 'actions', inputs: ['tag'], allowed_actions: [action], target: '{{input}}' },
      ],
    });
  }

  it('section.write schreibt in jede der zwei Notizen ihren eigenen Abschnitt', async () => {
    const paths = ['n/a.md', 'n/b.md'];
    const llm = new ScriptLlmClient([{ content: '## Zusammenfassung\n- nur A' }, { content: '## Zusammenfassung\n- nur B' }]);
    const h = await harness({ teamFm: inputTeam(paths, { family: 'section.write' }, 'section.replace'), files: pnFiles(paths), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(2);
    const a = await h.vault.read('n/a.md');
    const b = await h.vault.read('n/b.md');
    expect(a).toContain('- nur A');
    expect(a).not.toContain('- nur B');
    expect(b).toContain('- nur B');
    expect(b).not.toContain('- nur A');
    // Der Prompt trägt den neutralen Wortlaut, nicht das Briefing.
    expect(llm.calls[0]?.messages[0]?.content).toContain('dem fertigen Abschnitt');
    expect(llm.calls[0]?.messages[0]?.content).not.toContain('Briefing');
  });

  it('ein {{input}}-Pfad außerhalb von write_scope wird abgelehnt und nicht geschrieben', async () => {
    const paths = ['n/a.md', 'n/b.md', 'x/c.md'];
    const llm = new ScriptLlmClient([{ content: '## Z\n- A' }, { content: '## Z\n- B' }, { content: '## Z\n- C' }]);
    const h = await harness({ teamFm: inputTeam(paths, { family: 'section.write' }, 'section.replace'), files: pnFiles(paths), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(await h.vault.read('x/c.md')).toBe(PN_NOTE);
    expect(await h.vault.read('n/a.md')).toContain('- A');
    expect(r.writes).toBe(2);
    const apply = (await stateOf(h, r.runId)).tasks.find((t) => t.taskId === 'apply');
    expect(JSON.stringify(apply)).toMatch(/rejected/);
    expect(JSON.stringify(apply)).toContain('x/c.md');
  });

  it('ein Pfad auf der Sperrliste kommt nie als Eingabe an und wird nicht geschrieben, auch wenn write_scope ihn einschließt', async () => {
    // Der Collector filtert gesperrte Pfade vor dem Modellaufruf (zweite Sperre neben dem Executor): die Notiz hat weder einen
    // Aufruf noch eine Aktion, und die Datei bleibt unberührt.
    const paths = ['n/a.md', 'n/b.md', '_crews/geheim.md'];
    const llm = new ScriptLlmClient([{ content: '## Z\n- A' }, { content: '## Z\n- B' }, { content: '## Z\n- C' }]);
    const team = inputTeam(paths, { family: 'section.write' }, 'section.replace');
    team.write_scope = ['**/*.md'];
    const h = await harness({ teamFm: team, files: pnFiles(paths), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(llm.calls).toHaveLength(2);
    expect(await h.vault.read('_crews/geheim.md')).toBe(PN_NOTE);
    expect(r.writes).toBe(2);
    expect(JSON.stringify((await stateOf(h, r.runId)).tasks.filter((t) => t.taskId !== 'collect'))).not.toContain('geheim.md');
  });

  it('text.append mit heading hängt unter der Überschrift der Notiz an', async () => {
    const paths = ['n/a.md'];
    const body = '---\npriority: niedrig\n---\n# Notiz\n\n## Log\nalt\n\n## Ende\nschluss\n';
    const llm = new ScriptLlmClient([{ content: 'neu' }]);
    const h = await harness({
      teamFm: inputTeam(paths, { family: 'text.append', heading: 'Log' }, 'note.append'),
      files: { 'n/a.md': body }, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const after = await h.vault.read('n/a.md');
    expect(after).toMatch(/## Log\nalt\n+neu\n+## Ende/);
  });

  it('text.append hängt an jede Notiz ihren eigenen Text an', async () => {
    const paths = ['n/a.md', 'n/b.md'];
    const llm = new ScriptLlmClient([{ content: 'Zeile für A' }, { content: 'Zeile für B' }]);
    const h = await harness({ teamFm: inputTeam(paths, { family: 'text.append' }, 'note.append'), files: pnFiles(paths), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(2);
    expect((await h.vault.read('n/a.md')).trimEnd().endsWith('Zeile für A')).toBe(true);
    expect((await h.vault.read('n/b.md')).trimEnd().endsWith('Zeile für B')).toBe(true);
    expect(await h.vault.read('n/a.md')).not.toContain('Zeile für B');
  });
});

// ── notes.create: neue Notizen aus Notizen ───────────────────────────────────

describe('executeRun — notes.create', () => {
  const INBOX = ['00_Inbox/a.md', '00_Inbox/b.md'];
  const created = (...titles: string[]): ScriptedCall => ({
    content: JSON.stringify({ items: titles.map((title) => ({ title, body: `Text zu ${title}.` })) }),
  });

  function createTeam(output: Record<string, unknown> = {}): TeamFm {
    return triageTeamFm({
      limits: { max_writes: 10 },
      write_scope: ['10_Aufgaben/**/*.md'],
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: INBOX } },
        {
          id: 'make', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Lege Aufgaben an.', per_note: true, on_error: 'abort',
          output: { family: 'notes.create', folder: '10_Aufgaben/{{today}}', frontmatter: { type: '💪 Aufgabe', status: 'backlog' }, link_source: 'quelle', ...output },
        },
        { id: 'apply', kind: 'actions', inputs: ['make'], allowed_actions: ['note.create'] },
      ],
    });
  }

  it('legt je Notiz die Aufgaben an: fester Ordner, festes Frontmatter, Quell-Link, Text des Modells', async () => {
    const llm = new ScriptLlmClient([created('Angebot A'), created('Angebot B')]);
    const h = await harness({ teamFm: createTeam(), files: pnFiles(INBOX), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(2);
    const day = expandTarget('{{today}}', START_MS);
    const a = await h.vault.read(`10_Aufgaben/${day}/Angebot A.md`);
    expect(a).toContain('status: backlog');
    expect(a).toContain('[[00_Inbox/a]]');
    expect(a.trimEnd().endsWith('Text zu Angebot A.')).toBe(true);
    expect(await h.vault.read(`10_Aufgaben/${day}/Angebot B.md`)).toContain('[[00_Inbox/b]]');
    // Der Prompt nennt das Beispiel der Familie.
    expect(llm.calls[0]?.messages[0]?.content).toContain('"title": "Angebot an Meyer schicken"');
  });

  it('ein zweiter Lauf mit gleichen Titeln schreibt nichts und endet als partial, nicht als failed', async () => {
    const h = await harness({ teamFm: createTeam(), files: pnFiles(INBOX), llm: new ScriptLlmClient([created('Angebot A'), created('Angebot B')]) });
    const first = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(first.status).toBe('ok');
    const day = expandTarget('{{today}}', START_MS);
    const before = await h.vault.read(`10_Aufgaben/${day}/Angebot A.md`);

    const second = await runToCompletion(executeRun(h.teamPath, { ...h.deps, llm: new ScriptLlmClient([created('Angebot A'), created('Angebot B')]) }), h.clock);
    expect(second.status).toBe('partial');
    expect(second.writes).toBe(0);
    expect(second.errorKind).toBeNull();
    expect(await h.vault.read(`10_Aufgaben/${day}/Angebot A.md`)).toBe(before);
  });

  it('ist ein Titel belegt und der andere neu, wird nur der neue geschrieben (partial)', async () => {
    const h = await harness({ teamFm: createTeam(), files: pnFiles(INBOX), llm: new ScriptLlmClient([created('Angebot A'), created('Angebot B')]) });
    await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    const second = await runToCompletion(executeRun(h.teamPath, { ...h.deps, llm: new ScriptLlmClient([created('Angebot A'), created('Angebot C')]) }), h.clock);
    expect(second.status).toBe('partial');
    expect(second.writes).toBe(1);
    expect(await h.vault.exists(`10_Aufgaben/${expandTarget('{{today}}', START_MS)}/Angebot C.md`)).toBe(true);
  });

  it('ein Titel mit Schrägstrich ist eine ungültige Antwort (kein Unterordner), das Modell bekommt eine Reparatur-Runde', async () => {
    const llm = new ScriptLlmClient([created('Kunde/Meyer'), created('Kunde Meyer'), created('B')]);
    const h = await harness({ teamFm: createTeam(), files: pnFiles(INBOX), llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(llm.calls).toHaveLength(3);
    const day = expandTarget('{{today}}', START_MS);
    expect(await h.vault.exists(`10_Aufgaben/${day}/Kunde Meyer.md`)).toBe(true);
    expect(await h.vault.exists(`10_Aufgaben/${day}/Kunde`)).toBe(false);
  });
});

describe('executeRun — note.file und note.move', () => {
  const SRC = '00_Inbox/a.md';
  const IN_NOTE = '---\ntitle: A\n---\nAngebot für Meyer.\n';
  const answer = (to: string, path = SRC): ScriptedCall => ({ content: JSON.stringify({ items: [{ path, to }] }) });

  function fileTeam(output: Record<string, unknown>, scope: string[] = ['00_Inbox/**', '40_Projekte/**'], maxWrites = 10): TeamFm {
    return triageTeamFm({
      limits: { max_writes: maxWrites },
      write_scope: scope,
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: [SRC] } },
        { id: 'sort', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Lege ab.', output: { family: 'note.file', ...output }, on_error: 'abort' },
        { id: 'apply', kind: 'actions', inputs: ['sort'], allowed_actions: ['note.move'] },
      ],
    });
  }
  const FILES = {
    [SRC]: IN_NOTE, '40_Projekte/Meyer/x.md': 'x', '40_Projekte/Zeta/x.md': 'z', '40_Projekte/Privat/x.md': 'p',
  };
  const SCOPE = ['00_Inbox/**', '40_Projekte/Meyer/**', '40_Projekte/Zeta/**'];

  it('destinations_from: nimmt die Unterordner aus listFolders auf; Ordner außerhalb write_scope und auf der Sperrliste fehlen im Prompt und stehen in valueNotes', async () => {
    const llm = new ScriptLlmClient([answer('40_Projekte/Meyer')]);
    const h = await harness({ teamFm: fileTeam({ destinations_from: '40_Projekte' }, SCOPE), files: FILES, llm });
    await h.vault.mkdir('40_Projekte/.versteckt');
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const prompt = llm.calls[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('- 40_Projekte/Meyer');
    expect(prompt).toContain('- 40_Projekte/Zeta');
    expect(prompt).not.toContain('Privat');
    expect(prompt).not.toContain('versteckt');
    const rec = (await stateOf(h, r.runId)).tasks.find((t) => t.taskId === 'sort') as { valueNotes?: string[] } | undefined;
    const notes = (rec?.valueNotes ?? []).join('\n');
    expect(notes).toMatch(/40_Projekte\/Privat.*write_scope/);
    expect(notes).toMatch(/40_Projekte\/\.versteckt/);
    expect(await h.vault.read(await runMd(h, r.runId))).toContain('40_Projekte/Privat');
  });

  it('verschiebt die Notiz; im Schreibregister steht der neue Pfad statt des alten', async () => {
    const h = await harness({ teamFm: fileTeam({ destinations_from: '40_Projekte' }, SCOPE), files: FILES, llm: new ScriptLlmClient([answer('40_Projekte/Meyer')]) });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(1);
    expect(r.undoable).toBe(true);
    expect(await h.vault.exists(SRC)).toBe(false);
    expect(await h.vault.read('40_Projekte/Meyer/a.md')).toBe(IN_NOTE);
    const state = JSON.parse(await h.vault.read(`_crews/runs/${r.runId}/state.json`)) as { writeRegister: string[] };
    expect(state.writeRegister).toEqual(['40_Projekte/Meyer/a.md']);
    // Der Zug ist erfasst, bevor verschoben wurde: ein Eintrag am NEUEN Pfad mit movedFrom und dem Hash nach dem Lauf, kein Eintrag am alten Pfad.
    expect(h.snapshot.log.indexOf(`captureMove:${SRC}->40_Projekte/Meyer/a.md`)).toBeGreaterThan(-1);
    const entries = h.snapshot.manifests.get(r.runId)?.entries ?? [];
    expect(entries).toEqual([{ path: '40_Projekte/Meyer/a.md', movedFrom: SRC, existedBefore: true, preHash: null, postHash: fnv1a(IN_NOTE), blob: null }]);
  });

  it('feste Ziele stehen vor den Laufzeitzielen, ohne Doppelte; eine Liste ohne Hinweis hat nur die Ordnerzeile', async () => {
    const llm = new ScriptLlmClient([answer('none')]);
    const h = await harness({
      teamFm: fileTeam({ destinations: [{ folder: '40_Projekte/Zeta', when: 'Zeta-Kunden' }, { folder: '00_Inbox' }], destinations_from: '40_Projekte' }, SCOPE),
      files: FILES, llm,
    });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(0);
    expect(await h.vault.exists(SRC)).toBe(true);
    const prompt = llm.calls[0]?.messages[0]?.content ?? '';
    expect(prompt.indexOf('- 40_Projekte/Zeta: Zeta-Kunden')).toBeGreaterThan(-1);
    expect(prompt.indexOf('- 40_Projekte/Zeta: Zeta-Kunden')).toBeLessThan(prompt.indexOf('- 40_Projekte/Meyer'));
    expect(prompt.match(/^- 40_Projekte\/Zeta/gm)).toHaveLength(1);
  });

  it('höchstens 100 Ziele (DESTINATIONS_FROM_MAX), die Kürzung steht in valueNotes', async () => {
    const files: Record<string, string> = { [SRC]: IN_NOTE };
    for (let i = 1; i <= 120; i++) files[`40_Projekte/f${String(i).padStart(3, '0')}/x.md`] = 'x';
    const llm = new ScriptLlmClient([answer('none')]);
    const h = await harness({ teamFm: fileTeam({ destinations_from: '40_Projekte' }), files, llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    const prompt = llm.calls[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('- 40_Projekte/f100');
    expect(prompt).not.toContain('40_Projekte/f101');
    const rec = (await stateOf(h, r.runId)).tasks.find((t) => t.taskId === 'sort') as { valueNotes?: string[] } | undefined;
    expect((rec?.valueNotes ?? []).join('\n')).toMatch(/100 von 120/);
  });

  it('ein Ziel, das nicht in der Liste steht, ist eine ungültige Antwort: keine Verschiebung', async () => {
    const h = await harness({ teamFm: fileTeam({ destinations_from: '40_Projekte' }, SCOPE), files: FILES, llm: new ScriptLlmClient([answer('40_Projekte/Mayer'), answer('40_Projekte/Mayer')]) });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('invalid_output');
    expect(await h.vault.exists(SRC)).toBe(true);
  });

  it('Abschnitt schreiben und danach dieselbe Notiz verschieben verbraucht bei max_writes 1 nur einen Schreibvorgang (eigener Stand gilt nicht als stale)', async () => {
    const team = triageTeamFm({
      limits: { max_writes: 1 },
      write_scope: ['00_Inbox/**', '40_Projekte/**'],
      tasks: [
        { id: 'collect', kind: 'collector', collector: 'vault.read', params: { paths: [SRC] } },
        { id: 'brief', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Schreibe.', output: { family: 'section.write' }, on_error: 'abort' },
        { id: 'apply1', kind: 'actions', inputs: ['brief'], allowed_actions: ['section.replace'], target: SRC },
        { id: 'sort', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Lege ab.', output: { family: 'note.file', destinations: [{ folder: '40_Projekte/Meyer' }] }, on_error: 'abort' },
        { id: 'apply2', kind: 'actions', inputs: ['sort'], allowed_actions: ['note.move'] },
      ],
    });
    const llm = new ScriptLlmClient([{ content: '## Notiz\n- erledigt' }, answer('40_Projekte/Meyer')]);
    const h = await harness({ teamFm: team, files: FILES, llm });
    const r = await runToCompletion(executeRun(h.teamPath, h.deps), h.clock);
    expect(r.status).toBe('ok');
    expect(r.writes).toBe(1);
    const moved = await h.vault.read('40_Projekte/Meyer/a.md');
    expect(moved).toContain('- erledigt');
    expect(await h.vault.exists(SRC)).toBe(false);
    // Schreiben und Verschieben derselben Notiz ergibt einen Eintrag: Vorab-Inhalt aus dem Schreiben, neuer Pfad, Hash nach dem Lauf.
    const entries = h.snapshot.manifests.get(r.runId)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: '40_Projekte/Meyer/a.md', movedFrom: SRC, existedBefore: true, preHash: fnv1a(IN_NOTE), postHash: fnv1a(moved) });
    expect(h.snapshot.blobs.get(`${r.runId}/${entries[0]?.blob}`)).toBe(IN_NOTE);
  });
});

async function runMd(h: Harness, runId: string): Promise<string> {
  const p = `_crews/runs/${runId}/run.md`;
  if (!(await h.vault.exists(p))) throw new Error(`run.md fehlt: ${p}`);
  return p;
}

