import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalLlmClient } from '../../src/core/local-llm-client';
import { LlmCallError } from '../../src/core/ports';
import type { JsonTransport, LlmParams, SseTransport } from '../../src/core/ports';
import { FakeClock } from '../helpers/fake-clock';

const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures/streams', name), 'utf8');
const PARAMS: LlmParams = { model: 'qwen/qwen3.6-35b-a3b', temperature: 0.1, maxTokens: 512, thinking: 'auto' };
const TIMEOUTS = { callTimeoutMs: 300_000, stallTimeoutMs: 60_000 };

class FakeSse implements SseTransport {
	lastUrl = '';
	lastBody: Record<string, unknown> = {};
	private onChunk: ((raw: string) => void) | null = null;
	private resolve: ((status: number) => void) | null = null;
	private reject: ((e: Error) => void) | null = null;
	private status = 200;

	postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number> {
		this.lastUrl = url;
		this.lastBody = body as Record<string, unknown>;
		this.onChunk = onChunk;
		signal.addEventListener('abort', () => this.resolve?.(this.status));
		return new Promise((res, rej) => { this.resolve = res; this.reject = rej; });
	}
	emit(raw: string): void { this.onChunk?.(raw); }
	end(status = 200): void { this.status = status; this.resolve?.(status); }
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

function make(): { client: LocalLlmClient; sse: FakeSse; json: FakeJson; clock: FakeClock } {
	const sse = new FakeSse();
	const json = new FakeJson();
	const clock = new FakeClock(1_000_000);
	return { client: new LocalLlmClient('http://localhost:1234', sse, json, clock, TIMEOUTS), sse, json, clock };
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

	it('zählt reasoning_content als Think-Tokens, nie im content (reasoning.sse)', async () => {
		const { client, sse, clock } = make();
		const tokens: string[] = [];
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, (t) => tokens.push(t), new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('reasoning.sse'));
		const r = await p;
		expect(r.content).toBe('{"items": []}');
		expect(tokens.join('')).not.toContain('Der User');
		expect(r.thinkTokens).toBeGreaterThan(0);
	});

	it('splittet <think>-Tags aus dem content-Kanal (think-tags.sse)', async () => {
		const { client, sse, clock } = make();
		const tokens: string[] = [];
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, (t) => tokens.push(t), new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('think-tags.sse'));
		const r = await p;
		expect(r.content).toBe('Ergebnis');
		expect(tokens.join('')).toBe('Ergebnis');
		expect(r.thinkTokens).toBeGreaterThan(0);
	});

	it('sendet Suppression-Hints bei thinking=off (vault-rag-Muster)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], { ...PARAMS, thinking: 'off' }, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody.reasoning_effort).toBe('none');
		expect(sse.lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});

describe('LocalLlmClient thinking-Suppression', () => {
	it('sendet reasoning_effort "none" + enable_thinking:false + reasoning_budget:0 bei thinking:off', async () => {
		const { client, sse, clock } = make();
		const params: LlmParams = { model: 'm', temperature: 0.1, maxTokens: 128, thinking: 'off' };
		const p = client.stream([{ role: 'user', content: 'q' }], params, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody.reasoning_effort).toBe('none');
		expect(sse.lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(sse.lastBody.reasoning_budget).toBe(0);
	});

	it('sendet keine Suppress-Felder bei thinking:auto', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody.reasoning_effort).toBeUndefined();
		expect(sse.lastBody.reasoning_budget).toBeUndefined();
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
	it('fällt bei StreamNetworkError auf Non-Streaming (postJson) zurück', async () => {
		const { client, sse, json } = make();
		json.responses.set('http://localhost:1234/v1/chat/completions', {
			choices: [{ message: { content: 'Hallo aus Fallback' }, finish_reason: 'stop' }],
		});
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('StreamNetworkError');
		const r = await p;
		expect(r.content).toBe('Hallo aus Fallback');
		expect(r.finishReason).toBe('stop');
		expect(json.lastPostUrl).toBe('http://localhost:1234/v1/chat/completions');
		expect((json.lastPostBody as { stream?: boolean }).stream).toBe(false);
	});

	it('propagiert AbortError statt zurückzufallen', async () => {
		const { client, sse } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('AbortError');
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('erkennt Context-Overflow im Fallback-Body', async () => {
		const { client, sse, json } = make();
		json.responses.set('http://localhost:1234/v1/chat/completions', {
			error: { message: 'context length exceeded' },
		});
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('StreamNetworkError');
		await expect(p).rejects.toMatchObject({ kind: 'overflow' });
	});
});

describe('LocalLlmClient Metadaten', () => {
	it('ping/listModels über /v1/models', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/v1/models', { data: [{ id: 'a' }, { id: 'b' }] });
		expect(await client.ping('http://localhost:1234')).toBe(true);
		expect(await client.listModels()).toEqual(['a', 'b']);
		expect(await client.ping('http://tot:9')).toBe(false);
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
