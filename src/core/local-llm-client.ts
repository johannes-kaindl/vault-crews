/** LlmClient-Implementierung für LM Studio (OpenAI-kompatibel, localhost:1234).
 *  Transport ist injiziert (PROF-OBS-12) — der pure-Layer kennt kein XHR/requestUrl.
 *  Timeout-Realität (Spec §7): Hard-Timeout ab Call-Start; Stall-Detektor erst NACH dem
 *  ersten Token scharf (JIT-Modell-Laden braucht > 60 s bis zum ersten Token).
 *  Sampling und Denkstufe entscheidet nicht dieser Client: `LlmParams.params` kommt fertig aus
 *  `buildCrewParams` (Profil-Tabelle × Plugin-Überschreibung × Persona) und geht unverändert
 *  auf den Draht. Dass gpt-oss nie `reasoning_effort: none` bekommt (HTTP 400), steht dort in
 *  der Familien-Tabelle und als Golden-Zeile in `tests/core/crew-request.test.ts`. */
import { createChatClient, type ChatClient, type ChatResult, type SseTransport } from '../vendor/kit/chat-client';
import { normalizeEndpoint } from '../vendor/kit/endpoint';
import { authHeaders, type EndpointConfig } from '../vendor/kit/endpoint_config';
import { parseLmStudioContext, parseOllamaContext } from './model-info';
import { reasoningHappened } from '../vendor/kit/reasoning';
import type { ClockPort } from '../vendor/kit/clock';
import { LlmCallError } from './ports';
import type {
	JsonTransport, LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo,
} from './ports';

interface Timeouts { callTimeoutMs: number; stallTimeoutMs: number; }

/** Die Transporte des Kit-Chat-Clients: `transport` streamt (XHR), `fallbackTransport` wiederholt einmal
 *  ohne Stream, wenn ein Server den XHR abweist (Origin-/CORS-Prüfung; requestUrl sendet keinen Origin). */
export interface ChatTransports { transport: SseTransport; fallbackTransport?: SseTransport; }

export class LocalLlmClient implements LlmClient {
	private cfg: EndpointConfig;
	private base: string;
	private chat: ChatClient;

	constructor(
		endpoint: EndpointConfig,
		private readonly transports: ChatTransports,
		private readonly json: JsonTransport,
		private readonly clock: ClockPort,
		private readonly timeouts: Timeouts,
	) {
		this.cfg = endpoint;
		this.base = normalizeEndpoint(endpoint.url);
		this.chat = this.buildChat();
	}

	/** Ein Kit-Client je Endpunkt: dass ein Server den Stream verweigert, hängt an der Instanz — nach
	 *  einem Endpunktwechsel (`setEndpoint`) darf der neue Endpunkt die Weigerung des alten nicht erben.
	 *  Fristen: bis zum ersten Chunk gilt der Gesamt-Timer (JIT-Modell-Laden braucht > 60 s), danach
	 *  der Stall-Detektor; den harten Gesamt-Timer selbst kennt das Kit nicht, `stream` baut ihn nach. */
	private buildChat(): ChatClient {
		return createChatClient({
			...this.transports,
			clock: this.clock,
			idleTimeoutMs: this.timeouts.stallTimeoutMs,
			firstChunkTimeoutMs: this.timeouts.callTimeoutMs,
			nonStreamTimeoutMs: this.timeouts.callTimeoutMs,
		});
	}

	/** Retargetiert listModels/modelInfo/stream auf den (per ping() bestätigten)
	 *  erreichbaren Endpunkt — muss nach checkEndpointAndModel's Auflösung, vor jedem
	 *  weiteren Call laufen (s. orchestrator.ts checkEndpointAndModel). Nimmt den ganzen
	 *  Eintrag: URL und Schlüssel dürfen nie getrennt reisen. */
	setEndpoint(cfg: EndpointConfig): void {
		this.cfg = cfg;
		this.base = normalizeEndpoint(cfg.url);
		this.chat = this.buildChat();
	}

	/** Die Kopfzeilen des AKTIVEN Endpunkts. Ohne Schlüssel ein leeres Objekt — ein
	 *  lokaler Server bekommt keinen Authorization-Header angehängt. */
	private headers(): Record<string, string> {
		return authHeaders(this.cfg.apiKey);
	}

	/** Wirft nie (Falle 4): das Kit reicht einen werfenden ping durch und bräche damit die
	 *  Fallback-Kette ab — ein toter localhost würde verhindern, dass der gehostete
	 *  Zweitendpunkt überhaupt probiert wird. Der Schlüssel MUSS mit: ein Gateway, das
	 *  unauthentifiziert 401 antwortet, gälte sonst als tot. */
	async ping(endpoint: EndpointConfig): Promise<boolean> {
		try {
			await this.json.getJson(`${normalizeEndpoint(endpoint.url)}/v1/models`, authHeaders(endpoint.apiKey));
			return true;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		const res = await this.json.getJson(`${this.base}/v1/models`, this.headers());
		if (!isRecord(res) || !Array.isArray(res.data)) return [];
		return (res.data as unknown[])
			.map((m: unknown) => (isRecord(m) && typeof m.id === 'string' ? m.id : null))
			.filter((id): id is string => id !== null);
	}

	/** Best-effort Kontextlänge: erst LM Studios /api/v0/models, dann Ollamas
	 *  POST /api/show. Wer antwortet, gewinnt; sonst contextLength = null. */
	async modelInfo(model: string): Promise<ModelInfo | null> {
		try {
			const lm = await this.json.getJson(`${this.base}/api/v0/models`, this.headers());
			const ctx = parseLmStudioContext(lm, model);
			if (ctx) return { id: model, contextLength: ctx.loadedContextLength ?? ctx.maxContextLength ?? null };
		} catch { /* nächste Sonde */ }
		try {
			const oll = await this.json.postJson(`${this.base}/api/show`, { model }, this.headers());
			const ctx = parseOllamaContext(oll);
			if (ctx) return { id: model, contextLength: ctx.maxContextLength ?? null };
		} catch { /* aufgeben */ }
		return { id: model, contextLength: null };
	}

	async stream(
		messages: LlmMessage[],
		params: LlmParams,
		onToken: (t: string, isThink: boolean) => void,
		signal: AbortSignal,
	): Promise<LlmStreamResult> {
		// Harter Gesamt-Timer: den kennt das Kit nicht (dort misst die Frist Stille, nicht Dauer). Er bricht
		// über ein eigenes Signal ab; das Ergebnis heißt dann `aborted` — und `budgetFired` unterscheidet es
		// vom Abbruch durch den Aufrufer.
		const ctrl = new AbortController();
		let budgetFired = false;
		const onCallerAbort = (): void => ctrl.abort();
		if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onCallerAbort, { once: true });
		const budget = this.clock.setTimeout(() => { budgetFired = true; ctrl.abort(); }, this.timeouts.callTimeoutMs);

		let res: ChatResult;
		try {
			res = await this.chat.complete({
				endpoint: this.cfg,
				model: params.sentModel,
				messages,
				// Sampling gehört dem Plugin, nicht dem Kit-Client (Kit-Vertrag `params`).
				params: params.params,
				signal: ctrl.signal,
				onToken: (t) => onToken(t, false),
				onReasoning: (t) => onToken(t, true),
			});
		} finally {
			this.clock.clearTimeout(budget);
			signal.removeEventListener('abort', onCallerAbort);
		}

		if (res.ok) {
			return {
				content: res.content,
				thinkTokens: thinkTokens(res.reasoning),
				reasoned: reasoningHappened(res.content, res.reasoning),
				finishReason: res.finishReason === 'length' ? 'length' : 'stop',
				facts: {
					status: 200, finishReason: res.finishReason ?? null, content: res.content, reasoning: res.reasoning,
					...(res.model !== undefined ? { responseModel: res.model } : {}),
				},
			};
		}
		const partial = (finishReason: LlmStreamResult['finishReason']): LlmStreamResult => ({
			content: res.partial, thinkTokens: thinkTokens(res.reasoning), reasoned: reasoningHappened(res.partial, res.reasoning), finishReason,
		});
		switch (res.kind) {
			case 'aborted':
				if (budgetFired) throw new LlmCallError(`Kein Abschluss innerhalb ${this.timeouts.callTimeoutMs} ms`, 'timeout');
				return partial('aborted');
			case 'timeout':
				// Vor dem ersten Chunk gilt die Gesamtfrist (JIT-Laden), danach die Stille.
				throw res.timing.firstChunkAt === undefined
					? new LlmCallError(`Kein Abschluss innerhalb ${this.timeouts.callTimeoutMs} ms`, 'timeout')
					: new LlmCallError(`Kein neues Token innerhalb ${this.timeouts.stallTimeoutMs} ms`, 'stalled');
			case 'truncated':
				// Am Token-Limit abgeschnitten, ohne Text: der Orchestrator entscheidet über `length` (output_truncated).
				return { ...partial('length'), facts: { status: 200, finishReason: 'length', content: '', reasoning: res.reasoning } };
			case 'overflow':
				throw new LlmCallError(`HTTP ${String(res.status ?? 0)}: Kontextfenster überschritten`, 'overflow');
			case 'http':
				throw new LlmCallError(`HTTP ${String(res.status ?? 0)}: ${res.detail}`, 'http', { status: res.status ?? 0, detail: res.detail });
			case 'network':
				throw new Error(res.detail);
		}
	}
}

function thinkTokens(reasoningText: string): number {
	return Math.ceil(reasoningText.length / 3.5);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
