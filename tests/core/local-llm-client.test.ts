import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalLlmClient } from '../../src/core/local-llm-client';
import type { SseTransport } from '../../src/vendor/kit/chat-client';
import { LlmCallError } from '../../src/core/ports';
import type { JsonTransport, LlmParams } from '../../src/core/ports';
import { FakeClock } from '../helpers/fake-clock';

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures/streams', name), 'utf8');
const PARAMS: LlmParams = { model: 'qwen/qwen3.6-35b-a3b', sentModel: 'qwen/qwen3.6-35b-a3b', params: { temperature: 0.1, max_tokens: 512 }, thinkingLevel: 'off' };
const TIMEOUTS = { callTimeoutMs: 300_000, stallTimeoutMs: 60_000 };

/** Kit-Transportvertrag (obsidian-kit `SseTransport`). Verhalten wie der echte XHR-Transport: ein Abbruch
 *  über das Signal LEHNT ab (`AbortError`), er löst nicht auf. Bis Welle 11 löste diese Attrappe auf — und
 *  verdeckte damit, dass der alte Client bei einem Timer-Abbruch den AbortError statt `timeout`/`stalled`
 *  warf (gemessen am echten Obsidian). */
class FakeSse implements SseTransport {
	lastUrl = '';
	lastBody: Record<string, unknown> = {};
	lastHeaders: Record<string, string> = {};
	calls = 0;
	private onChunk: ((raw: string) => void) | null = null;
	private resolve: ((status: number) => void) | null = null;
	private reject: ((e: Error) => void) | null = null;

	postStream(url: string, body: unknown, headers: Record<string, string>, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number> {
		this.calls++;
		this.lastUrl = url;
		this.lastBody = body as Record<string, unknown>;
		this.lastHeaders = headers;
		this.onChunk = onChunk;
		return new Promise((res, rej) => {
			this.resolve = res;
			this.reject = rej;
			signal.addEventListener('abort', () => {
				const e = new Error('aborted');
				e.name = 'AbortError';
				rej(e);
			}, { once: true });
		});
	}
	emit(raw: string): void { this.onChunk?.(raw); }
	end(status = 200): void { this.resolve?.(status); }
	fail(name = 'StreamNetworkError'): void {
		const e = new Error('refused');
		e.name = name;
		this.reject?.(e);
	}
	/** Fixture zeilenweise in 2er-Chunks emitten und Stream beenden. */
	play(sse: string, status = 200): void {
		const lines = sse.split('\n');
		for (let i = 0; i < lines.length; i += 2) this.emit(lines.slice(i, i + 2).map((l) => `${l}\n`).join(''));
		this.end(status);
	}
}

class FakeJson implements JsonTransport {
	responses = new Map<string, unknown>();
	lastPostUrl = '';
	lastPostBody: unknown = null;
	async getJson(url: string): Promise<unknown> {
		if (!this.responses.has(url)) throw new Error(`no fixture for ${url}`);
		return this.responses.get(url);
	}
	async postJson(url: string, body: unknown): Promise<unknown> {
		this.lastPostUrl = url;
		this.lastPostBody = body;
		if (!this.responses.has(url)) return {};
		return this.responses.get(url);
	}
}

function make(): { client: LocalLlmClient; sse: FakeSse; fallback: FakeSse; json: FakeJson; clock: FakeClock } {
	const sse = new FakeSse();
	const fallback = new FakeSse();
	const json = new FakeJson();
	const clock = new FakeClock(1_000_000);
	return { client: new LocalLlmClient({ url: 'http://localhost:1234' }, { transport: sse, fallbackTransport: fallback }, json, clock, TIMEOUTS), sse, fallback, json, clock };
}

const tickAsync = async (clock: FakeClock, ms: number): Promise<void> => {
	await Promise.resolve();
	clock.tick(ms);
	await Promise.resolve();
};

describe('LocalLlmClient.stream', () => {
	it('akkumuliert content-Deltas und streamt Tokens (basic.sse)', async () => {
		const { client, sse, clock } = make();
		const tokens: string[] = [];
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, (t) => tokens.push(t), new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		const r = await p;
		expect(r.content).toBe('Hallo Welt');
		expect(tokens.join('')).toBe('Hallo Welt');
		expect(r.thinkTokens).toBe(0);
		expect(r.finishReason).toBe('stop');
		expect(sse.lastUrl).toBe('http://localhost:1234/v1/chat/completions');
		expect(sse.lastBody.stream).toBe(true);
	});

	it('meldet finishReason length, wenn der Server die Antwort am Token-Limit abschneidet (truncated.sse)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('truncated.sse'));
		const r = await p;
		expect(r.finishReason).toBe('length');
		expect(r.content).toBe('{"items": [{"title": "angefangen');
	});

	it('zählt reasoning_content als Think-Tokens, nie im content (reasoning.sse)', async () => {
		const { client, sse, clock } = make();
		const tokens: string[] = [];
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, (t, isThink) => { if (!isThink) tokens.push(t); }, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('reasoning.sse'));
		const r = await p;
		expect(r.content).toBe('{"items": []}');
		expect(tokens.join('')).not.toContain('Der User');
		expect(r.thinkTokens).toBeGreaterThan(0);
	});

	it('reasoned=true wenn das Modell gedacht hat (reasoning.sse)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('reasoning.sse'));
		const r = await p;
		expect(r.reasoned).toBe(true);
	});

	it('reasoned=false ohne Reasoning (basic.sse)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		const r = await p;
		expect(r.reasoned).toBe(false);
	});

	it('splittet <think>-Tags aus dem content-Kanal (think-tags.sse)', async () => {
		const { client, sse, clock } = make();
		const tokens: string[] = [];
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, (t, isThink) => { if (!isThink) tokens.push(t); }, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('think-tags.sse'));
		const r = await p;
		expect(r.content).toBe('Ergebnis');
		expect(tokens.join('')).toBe('Ergebnis');
		expect(r.thinkTokens).toBeGreaterThan(0);
	});

	it('sendet die fertigen Params flach in den Body und als Modell den Draht-Namen (sentModel)', async () => {
		const { client, sse, clock } = make();
		const params: LlmParams = {
			model: 'verdigado-pro', sentModel: 'openai/gpt-oss-120b',
			params: { temperature: 0.2, top_k: 20, reasoning_effort: 'minimal', max_tokens: 777 }, thinkingLevel: 'off',
		};
		const p = client.stream([{ role: 'user', content: 'q' }], params, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0.2, top_k: 20, reasoning_effort: 'minimal', max_tokens: 777 });
	});

	it('routes content tokens as isThink=false and reasoning tokens as isThink=true', async () => {
		const { client, sse, clock } = make();
		const seen: Array<[string, boolean]> = [];
		const p = client.stream(
			[{ role: 'user', content: 'q' }],
			PARAMS,
			(t, isThink) => seen.push([t, isThink]),
			new AbortController().signal,
		);
		await tickAsync(clock, 1);
		sse.emit('data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n');
		sse.emit('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
		sse.emit('data: {"choices":[{"delta":{"content":" <think>inner</think> world"}}]}\n\n');
		sse.end(200);
		await p;

		const think = seen.filter(([, k]) => k).map(([t]) => t).join('');
		const content = seen.filter(([, k]) => !k).map(([t]) => t).join('');
		expect(think).toContain('pondering');
		expect(think).toContain('inner');
		expect(content).toContain('Hello');
		expect(content).toContain('world');
		expect(content).not.toContain('inner'); // <think> gehört NICHT in Content
	});

	it('400 mit pretty-printed JSON-Body → lesbare einzeilige Message (nicht "{")', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.emit('{\n  "error": {\n    "message": "model \'foo\' not loaded"\n  }\n}');
		sse.end(400);
		await expect(p).rejects.toMatchObject({ kind: 'http' });
		const err = (await p.catch((e: unknown) => e as LlmCallError)) as LlmCallError;
		expect(err.message).toContain("model 'foo' not loaded");
		expect(err.message).not.toContain('\n');
	});
});

describe('LocalLlmClient — Antwort-Fakten für checkResponse, Fristen und Kontextlänge', () => {
	it('eine fertige Antwort trägt Status 200, Abschlussgrund, Inhalt und das, was der Server als Modell nennt', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		const r = await p;
		expect(r.facts).toMatchObject({ status: 200, content: 'Hallo Welt' });
		expect(r.facts?.reasoning).toEqual(expect.any(String));
	});

	it('ein HTTP-Fehler trägt Status und Servertext am LlmCallError (Grundlage für „Server lehnte die Anfrage ab")', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		const assertion = expect(p).rejects.toMatchObject({ kind: 'http', http: { status: 400 } });
		await tickAsync(clock, 1);
		sse.play('{"error":{"message":"bad param"}}', 400);
		await assertion;
	});

	it('Hard-Timeout ohne ersten Token → LlmCallError timeout (JIT-TTFB: Stall bleibt stumm)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout' });
		await tickAsync(clock, 90_000);   // > stallTimeout — darf vor erstem Token NICHT feuern
		await tickAsync(clock, 300_000);  // Hard-Timeout
		sse.end(200);
		await assertion;
	});

	it('Stall NACH erstem Token → LlmCallError stalled', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		const assertion = expect(p).rejects.toMatchObject({ kind: 'stalled' });
		await tickAsync(clock, 1);
		sse.emit('data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n');
		await tickAsync(clock, 61_000);
		sse.end(200);
		await assertion;
	});

	it('Timer-Abbruch kommt als LlmCallError an, obwohl der Transport ablehnt (AbortError) — nicht als AbortError', async () => {
		const { client, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		const assertion = expect(p).rejects.toBeInstanceOf(LlmCallError);
		await tickAsync(clock, 301_000);
		await assertion;
	});

	it('Caller-Abort mid-stream → finishReason aborted, kein Fehler', async () => {
		const { client, sse, clock } = make();
		const ctrl = new AbortController();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, ctrl.signal);
		await tickAsync(clock, 1);
		sse.emit('data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n');
		ctrl.abort();
		await tickAsync(clock, 1);
		const r = await p;
		expect(r.finishReason).toBe('aborted');
		expect(r.content).toBe('Hal');
	});

	it('HTTP 400 mit context-length-Hinweis → LlmCallError overflow', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		const assertion = expect(p).rejects.toMatchObject({ kind: 'overflow' });
		await tickAsync(clock, 1);
		sse.emit('{"error": "this request exceeds the model context length of 8192 tokens"}');
		sse.end(400);
		await assertion;
	});
});

describe('LocalLlmClient CORS-Fallback', () => {
	const url = 'http://localhost:1234/v1/chat/completions';
	const completion = (content: string, finish = 'stop'): string =>
		JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] });
	const start = async (client: LocalLlmClient, clock: FakeClock): Promise<{ p: Promise<import('../../src/core/ports').LlmStreamResult> }> => {
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		return { p };
	};

	it('fällt bei StreamNetworkError auf eine Anfrage ohne Stream über den Fallback-Transport zurück', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(completion('Hallo aus Fallback'));
		fallback.end(200);
		const r = await p;
		expect(r.content).toBe('Hallo aus Fallback');
		expect(r.finishReason).toBe('stop');
		expect(fallback.lastUrl).toBe(url);
		expect(fallback.lastBody.stream).toBe(false);
	});

	it('meldet finishReason length auch im Fallback', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(completion('{"items": [{"title": "ang', 'length'));
		fallback.end(200);
		expect((await p).finishReason).toBe('length');
	});

	it('der Fallback bleibt für weitere Aufrufe derselben Instanz (der Server verweigert den Stream)', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(completion('eins'));
		fallback.end(200);
		await p;
		const p2 = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		fallback.emit(completion('zwei'));
		fallback.end(200);
		expect((await p2).content).toBe('zwei');
		expect(sse.calls).toBe(1);
		expect(fallback.calls).toBe(2);
	});

	it('nach setEndpoint erbt der neue Endpunkt die Weigerung des alten nicht (frischer Kit-Client)', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(completion('eins'));
		fallback.end(200);
		await p;
		client.setEndpoint({ url: 'http://zweit:1234' });
		const p2 = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		expect(sse.calls).toBe(2);   // wieder der Stream-Transport
		sse.play(fixture('basic.sse'));
		expect((await p2).content).toBe('Hallo Welt');
	});

	it('ein AbortError des Transports ist kein Netzfehler: kein Fallback, Ergebnis aborted', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('AbortError');
		expect((await p).finishReason).toBe('aborted');
		expect(fallback.calls).toBe(0);
	});

	it('erkennt Context-Overflow im Fallback-Body', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		const assertion = expect(p).rejects.toMatchObject({ kind: 'overflow' });
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(JSON.stringify({ error: { message: 'context length exceeded' } }));
		fallback.end(200);
		await assertion;
	});

	it('klassifiziert erfolgreichen Fallback-Content mit "context window" nicht als Overflow', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.emit(completion('Das context window beschreibt die maximale Tokenanzahl.'));
		fallback.end(200);
		const r = await p;
		expect(r.content).toBe('Das context window beschreibt die maximale Tokenanzahl.');
		expect(r.finishReason).toBe('stop');
	});

	it('scheitert auch der Fallback am Netz, wirft der Client den Netzfehler (kein zweiter Versuch)', async () => {
		const { client, sse, fallback, clock } = make();
		const { p } = await start(client, clock);
		const assertion = expect(p).rejects.toThrow(/refused/);
		sse.fail('StreamNetworkError');
		await tickAsync(clock, 1);
		fallback.fail('StreamNetworkError');
		await assertion;
	});
});

describe('LocalLlmClient Metadaten', () => {
	it('ping/listModels über /v1/models', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/v1/models', { data: [{ id: 'a' }, { id: 'b' }] });
		expect(await client.ping({ url: 'http://localhost:1234' })).toBe(true);
		expect(await client.listModels()).toEqual(['a', 'b']);
		expect(await client.ping({ url: 'http://tot:9' })).toBe(false);
	});

	it('modelInfo bevorzugt loaded_context_length, fällt auf max_context_length und null zurück', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', {
			data: [
				{ id: 'm1', max_context_length: 32_768, loaded_context_length: 8192 },
				{ id: 'm2', max_context_length: 16_384 },
			],
		});
		expect(await client.modelInfo('m1')).toEqual({ id: 'm1', contextLength: 8192 });
		expect(await client.modelInfo('m2')).toEqual({ id: 'm2', contextLength: 16_384 });
		expect(await client.modelInfo('fehlt')).toEqual({ id: 'fehlt', contextLength: null });
	});

	it('modelInfo liefert contextLength:null, wenn keine Sonde greift', async () => {
		const { client } = make();
		expect(await client.modelInfo('m1')).toEqual({ id: 'm1', contextLength: null });
	});
});

describe('LocalLlmClient.modelInfo', () => {
	it('nimmt LM Studios loaded_context_length wenn /api/v0/models trifft', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', {
			data: [{ id: 'qwen3-8b', max_context_length: 32768, loaded_context_length: 8192 }],
		});
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: 8192 });
	});

	it('fällt auf Ollama /api/show zurück wenn LM Studio nichts liefert', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', { data: [] });
		json.responses.set('http://localhost:1234/api/show', { model_info: { 'qwen3.context_length': 40960 } });
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: 40960 });
		expect(json.lastPostUrl).toBe('http://localhost:1234/api/show');
		expect(json.lastPostBody).toEqual({ model: 'qwen3-8b' });
	});

	it('gibt {contextLength:null} wenn keine Sonde greift', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', { data: [] });
		json.responses.set('http://localhost:1234/api/show', {});
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: null });
	});
});
