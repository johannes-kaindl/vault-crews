import { describe, expect, it } from 'vitest';
import {
  buildCallEntries, CALL_LOG_FIELDS, CALL_STATUS, createCallRecorder, reasoningFieldOf, redactCallEntry, serializeCallEntry,
  type CallOutcome,
} from '../../src/core/call-log';
import type { TransportExchange } from '../../src/vendor/kit/recording-transport';

const IDS = { lauf: '2026-11-18-100000-demo', kontext: 'analyse', firstNr: 1, firstVersuch: 1 };

function exchange(over: Partial<TransportExchange> = {}): TransportExchange {
  return {
    url: 'http://localhost:1234/v1/chat/completions',
    body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    status: 200,
    raw: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_500,
    ...over,
  };
}

const OK: CallOutcome = { result: { content: 'ok', reasoning: '', finishReason: 'stop', aborted: false }, error: null };

describe('buildCallEntries', () => {
  it('Feldreihenfolge = CALL_LOG_FIELDS, Kopfzeilen kommen nicht vor, Dauer in Sekunden', () => {
    // Der Austausch des Kits hat keine Kopfzeilen; ein Transport, der welche mitgäbe, dürfte sie nicht in die Zeile bringen.
    const withHeaders = { ...exchange(), headers: { Authorization: 'Bearer sk-geheim' }, requestHeaders: { 'x-api-key': 'sk-geheim' } } as TransportExchange;
    const [e] = buildCallEntries([withHeaders], OK, IDS);
    expect(Object.keys(e!)).toEqual([...CALL_LOG_FIELDS]);
    const line = serializeCallEntry(e!);
    expect(line).not.toMatch(/authorization|x-api-key|sk-geheim/i);
    expect(e!.dauer_s).toBe(1.5);
    expect(e!.gestartet).toBe(new Date(1_700_000_000_000).toISOString());
    expect(e!.anfrage).toEqual({ url: 'http://localhost:1234/v1/chat/completions', body: withHeaders.body });
    expect(e!.antwort.http_status).toBe(200);
  });

  it('content mit U+2011, U+202F und Emoji steht als dieselben UTF-8-Bytes in der Zeile', () => {
    const content = 'Nicht‑trennbar 12 \u{1F600}';
    const [e] = buildCallEntries([exchange()], { ...OK, result: { content, reasoning: '', finishReason: 'stop', aborted: false } }, IDS);
    const bytes = new TextEncoder().encode(serializeCallEntry(e!));
    const needle = new TextEncoder().encode(content);
    const found = bytes.some((_, i) => needle.every((b, j) => bytes[i + j] === b));
    expect(found).toBe(true);
    expect(serializeCallEntry(e!).endsWith('\n')).toBe(true);
  });

  it('Status leer: HTTP 200 ohne Text und ohne Denken ist kein Erfolg', () => {
    const [e] = buildCallEntries([exchange()], { ...OK, result: { content: '', reasoning: '', finishReason: 'stop', aborted: false } }, IDS);
    expect(e!.status).toBe(CALL_STATUS.leer);
  });

  it('Status leer gilt nicht, wenn nur das Denken ankam', () => {
    const raw = 'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\n';
    const [e] = buildCallEntries([exchange({ raw })], { ...OK, result: { content: '', reasoning: 'hm', finishReason: 'stop', aborted: false } }, IDS);
    expect(e!.status).toBe(CALL_STATUS.ok);
    expect(e!.reasoning_feld).toBe('reasoning_content');
  });

  it('Status datenstrom_trotz_stream_false: Body stream:false, Rohantwort ist SSE (der Client lehnt sie als HTTP-Fehler ab)', () => {
    const x = exchange({ body: { model: 'm', stream: false, messages: [] } });
    const [e] = buildCallEntries([x], { result: null, error: { kind: 'http', message: 'HTTP 200: kein JSON' } }, IDS);
    expect(e!.status).toBe(CALL_STATUS.datenstromTrotzStreamFalse);
    expect(e!.antwort.body).toBeNull();
    expect(e!.antwort.roh).toBe(x.raw);
  });

  it('Status abgeschnitten bei finish_reason length', () => {
    const [e] = buildCallEntries([exchange()], { ...OK, result: { content: 'ab', reasoning: '', finishReason: 'length', aborted: false } }, IDS);
    expect(e!.status).toBe(CALL_STATUS.abgeschnitten);
    expect(e!.finish_reason).toBe('length');
  });

  it.each([
    ['overflow', CALL_STATUS.ueberlauf], ['timeout', CALL_STATUS.zeitueberschreitung], ['stalled', CALL_STATUS.stille],
    ['http', CALL_STATUS.httpFehler], ['other', CALL_STATUS.netzfehler],
  ] as const)('Fehlerart %s ergibt den Status %s samt Fehlertext', (kind, status) => {
    const [e] = buildCallEntries([exchange({ status: kind === 'other' ? null : 500, raw: '' })], { result: null, error: { kind, message: 'boom' } }, IDS);
    expect(e!.status).toBe(status);
    expect(e!.fehler).toBe('boom');
  });

  it('Abbruch: Status abgebrochen mit Teil-Rohtext und dem Fehler des Transports', () => {
    const x = exchange({ status: null, raw: 'data: {"choices":[{"delta":{"content":"te"}}]}\n\n', error: 'AbortError: aborted' });
    const [e] = buildCallEntries([x], { result: { content: 'te', reasoning: '', finishReason: null, aborted: true }, error: null }, IDS);
    expect(e!.status).toBe(CALL_STATUS.abgebrochen);
    expect(e!.antwort.http_status).toBeNull();
    expect(e!.antwort.roh).toBe(x.raw);
    expect(e!.fehler).toBe('AbortError: aborted');
  });

  it('Fallback: zwei Austausche, der erste ist netzfehler, Ergebnis und Antwort-Body gehören nur zum letzten; nr und versuch zählen weiter', () => {
    const first = exchange({ status: null, raw: '', error: 'StreamNetworkError: refused' });
    const second = exchange({ body: { model: 'm', stream: false }, raw: '{"choices":[{"message":{"content":"ok"}}]}' });
    const [a, b] = buildCallEntries([first, second], OK, { ...IDS, firstNr: 4, firstVersuch: 2 });
    expect([a!.nr, a!.versuch, b!.nr, b!.versuch]).toEqual([4, 2, 5, 3]);
    expect(a!.status).toBe(CALL_STATUS.netzfehler);
    expect(a!.fehler).toBe('StreamNetworkError: refused');
    expect(a!.content).toBe('');
    expect(b!.status).toBe(CALL_STATUS.ok);
    expect(b!.content).toBe('ok');
    expect(b!.antwort.body).toEqual({ choices: [{ message: { content: 'ok' } }] });
  });
});

describe('reasoningFieldOf', () => {
  it.each([
    ['{"reasoning_content":"x"}', 'reasoning_content'], ['{"reasoning":"x"}', 'reasoning'], ['{"thinking":"x"}', 'thinking'],
    ['data: {"content":"<think>x</think>y"}', 'think-tag'], ['data: {"content":"x<channel|>y"}', 'channel'],
  ] as const)('%s → %s', (raw, field) => {
    expect(reasoningFieldOf(raw, 'x')).toBe(field);
  });
  it('null ohne Denken', () => {
    expect(reasoningFieldOf('{"reasoning_content":"x"}', '')).toBeNull();
  });
});

describe('redactCallEntry', () => {
  it('schwärzt Schlüssel überall in der Zeile und PEM-Blöcke in content/reasoning mit den Standardregeln', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const [e] = buildCallEntries(
      [exchange({ raw: 'Gateway: sk-geheim-1234567890 abgelehnt' })],
      { result: { content: `Hier: ${pem}`, reasoning: pem, finishReason: 'stop', aborted: false }, error: null }, IDS,
    );
    const out = serializeCallEntry(redactCallEntry(e!, ['sk-geheim-1234567890']));
    expect(out).not.toContain('sk-geheim-1234567890');
    expect(out).not.toContain('MIIabc');
    expect(out).toContain('redacted');
  });
});

describe('createCallRecorder', () => {
  it('take gibt die angenommenen Austausche heraus und leert den Puffer', () => {
    const r = createCallRecorder();
    r.accept(exchange());
    r.accept(exchange());
    expect(r.take()).toHaveLength(2);
    expect(r.take()).toHaveLength(0);
  });
});
