/** LlmClient-Implementierung für LM Studio (OpenAI-kompatibel, localhost:1234).
 *  Transport ist injiziert (PROF-OBS-12) — der pure-Layer kennt kein XHR/requestUrl.
 *  Timeout-Realität (Spec §7): Hard-Timeout ab Call-Start; Stall-Detektor erst NACH dem
 *  ersten Token scharf (JIT-Modell-Laden braucht > 60 s bis zum ersten Token).
 *  Thinking-Suppression nach vault-rag-Muster (reasoning_effort + chat_template_kwargs). */
import { parseSSE } from '../vendor/kit/sse';
import { ThinkSplitter } from '../vendor/kit/think';
import { normalizeEndpoint } from '../vendor/kit/endpoint';
import { parseLmStudioContext, parseOllamaContext } from './model-info';
import { LlmCallError } from './ports';
import type {
	ClockPort, JsonTransport, LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo, SseTransport,
} from './ports';

const ERROR_BODY_CAP = 4096;

interface Timeouts { callTimeoutMs: number; stallTimeoutMs: number; }

export class LocalLlmClient implements LlmClient {
	private base: string;

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
		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			stream: true,
		};
		if (params.thinking === 'off') {
			body.reasoning_effort = 'none';
			body.chat_template_kwargs = { enable_thinking: false };
		}

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
		} finally {
			this.clock.clearTimeout(hardTimer);
			if (stallTimer !== null) this.clock.clearTimeout(stallTimer);
			signal.removeEventListener('abort', onCallerAbort);
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
			if (/context (length|window)|too many tokens/i.test(rawBody)) {
				throw new LlmCallError(`HTTP ${status}: Kontextfenster überschritten`, 'overflow');
			}
			throw new LlmCallError(`HTTP ${status}: ${rawBody.slice(0, 300)}`, 'http');
		}
		return { content, thinkTokens: thinkTokens(reasoningText), finishReason: 'stop' };
	}
}

function thinkTokens(reasoningText: string): number {
	return Math.ceil(reasoningText.length / 3.5);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
