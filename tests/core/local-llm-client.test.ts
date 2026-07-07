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
	private status = 200;

	postStream(url: string, body: unknown, onChunk: (raw: string) => void, signal: AbortSignal): Promise<number> {
		this.lastUrl = url;
		this.lastBody = body as Record<string, unknown>;
		this.onChunk = onChunk;
		signal.addEventListener('abort', () => this.resolve?.(this.status));
		return new Promise((res) => { this.resolve = res; });
	}
	emit(raw: string): void { this.onChunk?.(raw); }
	end(status = 200): void { this.status = status; this.resolve?.(status); }
	/** Fixture zeilenweise in 2er-Chunks emitten und Stream beenden. */
	play(sse: string, status = 200): void {
		const lines = sse.split('\n');
		for (let i = 0; i < lines.length; i += 2) this.emit(lines.slice(i, i + 2).map((l) => `${l}\n`).join(''));
		this.end(status);
	}
}

class FakeJson implements JsonTransport {
	responses = new Map<string, unknown>();
	async getJson(url: string): Promise<unknown> {
		if (!this.responses.has(url)) throw new Error(`no fixture for ${url}`);
		return this.responses.get(url);
	}
	async postJson(): Promise<unknown> { return {}; }
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
		expect(await client.modelInfo('fehlt')).toBeNull();
	});

	it('modelInfo liefert null, wenn /api/v0/models nicht verfügbar ist', async () => {
		const { client } = make();
		expect(await client.modelInfo('m1')).toBeNull();
	});
});
