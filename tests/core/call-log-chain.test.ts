/** Die echte Kette: LocalLlmClient (Kit-Chat-Client) → recordingTransport → Recorder → Orchestrator → calls.jsonl.gz.
 *  Die Transport-Attrappen lehnen wie die echten ab (XHR: `StreamNetworkError` bei verweigerter Verbindung, `AbortError` bei Abbruch). */
import { describe, expect, it } from 'vitest';
import { executeRun, type RunDeps } from '../../src/core/orchestrator';
import { LocalLlmClient } from '../../src/core/local-llm-client';
import { createCallRecorder, CALL_STATUS, type CallLogEntry } from '../../src/core/call-log';
import { recordingTransport } from '../../src/vendor/kit/recording-transport';
import { gunzipText } from '../../src/vendor/kit/gzip-text';
import type { SseTransport } from '../../src/vendor/kit/chat-client';
import type { JsonTransport } from '../../src/core/ports';
import { DEFAULT_REQUEST_SETTINGS } from '../../src/vendor/kit/sampling-profiles';
import { InMemoryVaultPort, FixtureMetadataPort } from '../helpers/in-memory-vault';
import { FakeClock } from '../helpers/fake-clock';
import { RecorderReporter } from '../helpers/recorder-reporter';
import { FakeSnapshotStore } from '../helpers/fake-snapshot';
import { fakeRequestPort } from '../helpers/fake-request-port';

const KEY = 'sk-geheim-1234567890';
const TRIAGE_OK = '{"items":[{"path":"10_Aufgaben/a.md","set":{"priority":"mittel"}}]}';
const TASK_NOTE = '---\npriority: 1_niedrig_🟢\n---\nInhalt\n';

const sse = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;

function netError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const json: JsonTransport = {
  getJson: async () => ({ data: [{ id: 'test-model' }] }),
  postJson: async () => ({}),
};

async function setup(opts: { stream: SseTransport; fallback?: SseTransport; abort?: AbortSignal }) {
  const vault = new InMemoryVaultPort();
  const meta = new FixtureMetadataPort(vault);
  const teamPath = '_crews/teams/task-triage.md';
  await vault.create(teamPath, 'Doku.');
  meta.setFrontmatter(teamPath, {
    'crew-kind': 'team', name: 'Task-Triage', version: 1, trigger: 'manual', description: '', limits: { max_writes: 10 }, review: false,
    write_scope: ['10_Aufgaben/**/*.md'],
    tasks: [
      { id: 'collect', kind: 'collector', collector: 'vault.list', params: { folder: '10_Aufgaben' } },
      { id: 'analyse', kind: 'llm', agent: 'triage-analyst', inputs: ['collect'], instruction: 'Bewerte.', output_schema: 'triage-v1', on_error: 'abort' },
      { id: 'apply', kind: 'actions', inputs: ['analyse'], allowed_actions: ['frontmatter.patch'], allowed_keys: ['priority'] },
    ],
  });
  await vault.create('_crews/agents/triage-analyst.md', 'Du bist ein Triage-Analyst.');
  meta.setFrontmatter('_crews/agents/triage-analyst.md', { 'crew-kind': 'agent', name: 'Triage-Analyst' });
  await vault.create('10_Aufgaben/a.md', TASK_NOTE);

  const callLog = createCallRecorder();
  const clock = new FakeClock(1_700_000_000_000);
  const wrap = (t: SseTransport): SseTransport => recordingTransport(t, (x) => callLog.accept(x));
  const llm = new LocalLlmClient(
    { url: 'http://gw:1', apiKey: KEY, model: 'test-model' },
    { transport: wrap(opts.stream), ...(opts.fallback !== undefined ? { fallbackTransport: wrap(opts.fallback) } : {}) },
    json, async () => null, clock, { callTimeoutMs: 300_000, stallTimeoutMs: 60_000 },
  );
  const reporter = new RecorderReporter();
  const deps: RunDeps = {
    vault, meta, llm, request: fakeRequestPort(), snapshot: new FakeSnapshotStore(), clock, reporter, callLog,
    settings: {
      crewRoot: '_crews', configDir: '.obsidian', endpoints: [{ url: 'http://gw:1', apiKey: KEY, model: 'test-model' }], deniedEndpoints: [],
      limits: { maxWrites: 10, maxLlmCalls: 4, wallClockMs: 600_000, maxNoteBytes: 65_536, callTimeoutMs: 300_000, stallTimeoutMs: 60_000 },
      undoHistoryDepth: 15, request: DEFAULT_REQUEST_SETTINGS,
    },
    abort: opts.abort ?? new AbortController().signal,
  };
  return { vault, deps, teamPath };
}

async function entriesOf(vault: InMemoryVaultPort, runId: string): Promise<{ text: string; entries: CallLogEntry[] }> {
  const text = await gunzipText(vault.binaries.get(`_crews/runs/${runId}/calls.jsonl.gz`)!);
  return { text, entries: text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as CallLogEntry) };
}

describe('Mitschnitt mit dem echten Chat-Client', () => {
  it('Fallback: der XHR-Stream wird abgelehnt, requestUrl antwortet → zwei Einträge (netzfehler, dann ok), kein Authorization, kein Schlüssel im Text', async () => {
    const stream: SseTransport = { postStream: () => Promise.reject(netError('StreamNetworkError', 'refused')) };
    const fallback: SseTransport = {
      postStream: (_url, _body, _headers, onChunk) => {
        onChunk(JSON.stringify({ choices: [{ message: { content: TRIAGE_OK }, finish_reason: 'stop' }], model: 'test-model' }));
        return Promise.resolve(200);
      },
    };
    const { vault, deps, teamPath } = await setup({ stream, fallback });
    const result = await executeRun(teamPath, deps);

    expect(result.status).toBe('ok');
    const { text, entries } = await entriesOf(vault, result.runId);
    expect(entries.map((e) => [e.nr, e.versuch, e.status])).toEqual([[1, 1, CALL_STATUS.netzfehler], [2, 2, CALL_STATUS.ok]]);
    expect(entries[0]!.fehler).toBe('StreamNetworkError: refused');
    expect((entries[0]!.anfrage.body as { stream: boolean }).stream).toBe(true);
    expect((entries[1]!.anfrage.body as { stream: boolean }).stream).toBe(false);
    expect(entries[1]!.content).toBe(TRIAGE_OK);
    expect(entries[1]!.antwort.body).toMatchObject({ model: 'test-model' });
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toContain(KEY);
  });

  it('Normalfall über den Stream: ein Eintrag, Roh-SSE und Text', async () => {
    const stream: SseTransport = { postStream: (_u, _b, _h, onChunk) => { onChunk(sse(TRIAGE_OK)); return Promise.resolve(200); } };
    const { vault, deps, teamPath } = await setup({ stream });
    const result = await executeRun(teamPath, deps);
    const { entries } = await entriesOf(vault, result.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe(CALL_STATUS.ok);
    expect(entries[0]!.antwort.roh).toBe(sse(TRIAGE_OK));
    expect(entries[0]!.antwort.body).toBeNull();
    expect(entries[0]!.finish_reason).toBe('stop');
  });

  it('Abbruch mitten im Strom: ein Eintrag abgebrochen mit dem Teil-Rohtext (der Transport lehnt mit AbortError ab)', async () => {
    const ac = new AbortController();
    const stream: SseTransport = {
      postStream: (_u, _b, _h, onChunk, signal) => new Promise<number>((_res, rej) => {
        onChunk(sse('{"ite'));
        signal.addEventListener('abort', () => rej(netError('AbortError', 'aborted')), { once: true });
        ac.abort();
      }),
    };
    const { vault, deps, teamPath } = await setup({ stream, abort: ac.signal });
    const result = await executeRun(teamPath, deps);

    expect(result.status).toBe('aborted');
    const { entries } = await entriesOf(vault, result.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe(CALL_STATUS.abgebrochen);
    expect(entries[0]!.antwort.http_status).toBeNull();
    expect(entries[0]!.antwort.roh).toContain('{\\"ite');
    expect(entries[0]!.fehler).toBe('AbortError: aborted');
    expect(entries[0]!.content).toBe('{"ite');
  });
});
