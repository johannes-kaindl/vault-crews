/** LlmClient-Implementierung für LM Studio (OpenAI-kompatibel, localhost:1234).
 *  Transport ist injiziert (PROF-OBS-12) — der pure-Layer kennt kein XHR/requestUrl.
 *  Timeout-Realität (Spec §7): Hard-Timeout ab Call-Start; Stall-Detektor erst NACH dem
 *  ersten Token scharf (JIT-Modell-Laden braucht > 60 s bis zum ersten Token).
 *  Thinking-Suppression nach vault-rag-Muster (reasoning_effort + chat_template_kwargs). */
import { parseSSE } from '../vendor/kit/sse';
import { ThinkSplitter } from '../vendor/kit/think';
import { normalizeEndpoint } from '../vendor/kit/endpoint';
import { parseLmStudioContext, parseOllamaContext, suppressParams } from './model-info';
import { isContextOverflow, extractChatContent } from './chat-response';
import { LlmCallError } from './ports';
import type {
	ClockPort, JsonTransport, LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo, SseTransport,
} from './ports';

const ERROR_BODY_CAP = 4096;

interface Timeouts { callTimeoutMs: number; stallTimeoutMs: number; }

export class LocalLlmClient implements LlmClient {
	private base: string;
	private streamRefused = false;

	constructor(
		base: string,
		private readonly sse: SseTransport,
		private readonly json: JsonTransport,
		private readonly clock: ClockPort,
		private readonly timeouts: Timeouts,
	) {
		this.base = normalizeEndpoint(base);
	}

	/** Retargetiert listModels/modelInfo/stream auf den (per ping() bestätigten)
	 *  erreichbaren Endpoint — muss nach checkEndpointAndModel's resolveActiveEndpoint,
	 *  vor jedem weiteren Call laufen (s. orchestrator.ts checkEndpointAndModel). */
	setBase(endpoint: string): void {
		this.base = normalizeEndpoint(endpoint);
	}

	async ping(endpoint: string): Promise<boolean> {
		try {
			await this.json.getJson(`${endpoint}/v1/models`);
			return true;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		const res = await this.json.getJson(`${this.base}/v1/models`);
		if (!isRecord(res) || !Array.isArray(res.data)) return [];
		return (res.data as unknown[])
			.map((m: unknown) => (isRecord(m) && typeof m.id === 'string' ? m.id : null))
			.filter((id): id is string => id !== null);
	}

	/** Best-effort Kontextlänge: erst LM Studios /api/v0/models, dann Ollamas
	 *  POST /api/show. Wer antwortet, gewinnt; sonst contextLength = null. */
	async modelInfo(model: string): Promise<ModelInfo | null> {
		try {
			const lm = await this.json.getJson(`${this.base}/api/v0/models`);
			const ctx = parseLmStudioContext(lm, model);
			if (ctx) return { id: model, contextLength: ctx.loadedContextLength ?? ctx.maxContextLength ?? null };
		} catch { /* nächste Sonde */ }
		try {
			const oll = await this.json.postJson(`${this.base}/api/show`, { model });
			const ctx = parseOllamaContext(oll);
			if (ctx) return { id: model, contextLength: ctx.maxContextLength ?? null };
		} catch { /* aufgeben */ }
		return { id: model, contextLength: null };
	}

	async stream(
		messages: LlmMessage[],
		params: LlmParams,
		onToken: (t: string) => void,
		signal: AbortSignal,
	): Promise<LlmStreamResult> {
		if (this.streamRefused) return this.streamNonStreaming(messages, params, signal);

		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			stream: true,
			...suppressParams(params.thinking === 'off'),
		};

		const ctrl = new AbortController();
		const onCallerAbort = (): void => ctrl.abort();
		signal.addEventListener('abort', onCallerAbort);

		const splitter = new ThinkSplitter();
		let content = '';
		let reasoningText = '';
		let rest = '';
		let rawBody = '';
		let abortKind: 'timeout' | 'stalled' | null = null;
		let sawToken = false;

		const hardTimer = this.clock.setTimeout(() => {
			abortKind = 'timeout';
			ctrl.abort();
		}, this.timeouts.callTimeoutMs);
		let stallTimer: number | null = null;
		const armStall = (): void => {
			if (stallTimer !== null) this.clock.clearTimeout(stallTimer);
			stallTimer = this.clock.setTimeout(() => {
				abortKind = 'stalled';
				ctrl.abort();
			}, this.timeouts.stallTimeoutMs);
		};

		const emit = (piece: string): void => {
			const parts = splitter.push(piece);
			if (parts.content !== '') {
				content += parts.content;
				onToken(parts.content);
			}
			reasoningText += parts.reasoning;
		};

		let status: number;
		let streamError: unknown = null;
		try {
			status = await this.sse.postStream(
				`${this.base}/v1/chat/completions`,
				body,
				(raw) => {
					if (rawBody.length < ERROR_BODY_CAP) rawBody += raw;
					const parsed = parseSSE(rest + raw);
					rest = parsed.rest;
					for (const delta of parsed.content) emit(delta);
					for (const r of parsed.reasoning) reasoningText += r;
					if (parsed.content.length > 0 || parsed.reasoning.length > 0) {
						sawToken = true;
						armStall(); // Stall erst nach erstem Token scharf (JIT-TTFB)
					}
				},
				ctrl.signal,
			);
		} catch (e) {
			streamError = e;
			status = 0;
		} finally {
			this.clock.clearTimeout(hardTimer);
			if (stallTimer !== null) this.clock.clearTimeout(stallTimer);
			signal.removeEventListener('abort', onCallerAbort);
		}

		if (streamError !== null) {
			const err = streamError instanceof Error ? streamError : new Error('Unbekannter Stream-Fehler');
			if (err.name === 'AbortError') throw err;
			if (err.name === 'StreamNetworkError') {
				this.streamRefused = true;
				return this.streamNonStreaming(messages, params, signal);
			}
			throw err; // unerwarteter Fehler — nicht schlucken
		}

		const tail = splitter.flush();
		if (tail.content !== '') {
			content += tail.content;
			onToken(tail.content);
		}
		reasoningText += tail.reasoning;

		if (signal.aborted) {
			return { content, thinkTokens: thinkTokens(reasoningText), finishReason: 'aborted' };
		}
		if (abortKind !== null) {
			throw new LlmCallError(
				abortKind === 'timeout'
					? `Kein Abschluss innerhalb ${this.timeouts.callTimeoutMs} ms (sawToken=${String(sawToken)})`
					: `Kein neues Token innerhalb ${this.timeouts.stallTimeoutMs} ms`,
				abortKind,
			);
		}
		if (status !== 200) {
			if (isContextOverflow(rawBody)) {
				throw new LlmCallError(`HTTP ${status}: Kontextfenster überschritten`, 'overflow');
			}
			throw new LlmCallError(`HTTP ${status}: ${rawBody.slice(0, 300)}`, 'http');
		}
		return { content, thinkTokens: thinkTokens(reasoningText), finishReason: 'stop' };
	}

	/** Non-Streaming-Fallback (CORS-frei via JsonTransport.postJson). Content wird zuerst
	 *  extrahiert; nur wenn kein content vorhanden ist (echter Fehlerbody) wird auf Overflow
	 *  gesnifft — sonst würde eine erfolgreiche Antwort, die z.B. "context window" im Text
	 *  erwähnt, fälschlich als Overflow klassifiziert. Der HTTP-Status ist über postJson
	 *  nicht sichtbar, wird hier aber (wie im Streaming-Pfad) auch nicht gebraucht. */
	private async streamNonStreaming(
		messages: LlmMessage[],
		params: LlmParams,
		signal: AbortSignal,
	): Promise<LlmStreamResult> {
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			stream: false,
			...suppressParams(params.thinking === 'off'),
		};
		const res = await this.json.postJson(`${this.base}/v1/chat/completions`, body);
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const extracted = extractChatContent(res);
		if (extracted !== null) {
			return { content: extracted.content, thinkTokens: thinkTokens(extracted.reasoning), finishReason: 'stop' };
		}
		// Kein content extrahierbar → das ist ein echter Fehlerbody, hier erst auf Overflow sniffen.
		const rawBody = JSON.stringify(res ?? {});
		if (isContextOverflow(rawBody)) {
			throw new LlmCallError('Kontextfenster überschritten (Non-Streaming)', 'overflow');
		}
		throw new LlmCallError(`Non-Streaming-Antwort ohne content: ${rawBody.slice(0, 300)}`, 'http');
	}
}

function thinkTokens(reasoningText: string): number {
	return Math.ceil(reasoningText.length / 3.5);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
