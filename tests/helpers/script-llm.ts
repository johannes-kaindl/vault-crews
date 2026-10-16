import type { LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo } from '../../src/core/ports';
import { LlmCallError } from '../../src/core/ports';
import type { ResponseFacts } from '../../src/vendor/kit/sampling-profiles';

export interface ScriptedCall {
	content?: string;
	thinkTokens?: number;
	reasoned?: boolean;
	finishReason?: LlmStreamResult['finishReason'];
	/** Fehlerinjektion statt Antwort. */
	error?: 'overflow' | 'timeout' | 'stalled' | 'http';
	/** Status und Servertext eines injizierten HTTP-Fehlers (wie ihn der echte Client am LlmCallError trägt). */
	httpDetail?: { status: number; detail: string };
	/** Wie Gemma 4 ohne Öffner: der Text bis hier ging als Antwort hinaus, war aber Denken — der Client meldet das Zurücksetzen. */
	resetAfterChars?: number;
	/** Antwort-Fakten für `checkResponse` (der echte Client liefert sie immer). */
	facts?: ResponseFacts;
}

export class ScriptLlmClient implements LlmClient {
	readonly calls: { messages: LlmMessage[]; params: LlmParams }[] = [];
	readonly baseCalls: string[] = [];
	constructor(private queue: ScriptedCall[], private ctxLength: number | null = 8192) {}

	async ping(_cfg?: { url: string }): Promise<boolean> { return true; }
	setEndpoint(cfg?: { url: string }): void { this.baseCalls.push(cfg?.url ?? ''); }
	async listModels(): Promise<string[]> { return ['test-model']; }
	async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: this.ctxLength }; }

	async stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string, isThink: boolean) => void, _signal: AbortSignal, onContentReset?: () => void): Promise<LlmStreamResult> {
		this.calls.push({ messages, params });
		const step = this.queue.shift();
		if (!step) throw new Error('ScriptLlmClient: Queue leer — Test hat mehr Calls gemacht als gescriptet');
		if (step.error) throw new LlmCallError(`injected: ${step.error}`, step.error, step.httpDetail);
		const content = step.content ?? '';
		if (step.resetAfterChars !== undefined) {
			for (const chunk of content.slice(0, step.resetAfterChars).match(/.{1,8}/gs) ?? []) onToken(chunk, false);
			onContentReset?.();
			for (const chunk of content.slice(step.resetAfterChars).match(/.{1,8}/gs) ?? []) onToken(chunk, false);
		} else {
			for (const chunk of content.match(/.{1,8}/gs) ?? []) onToken(chunk, false);
		}
		return {
			content, thinkTokens: step.thinkTokens ?? 0, reasoned: step.reasoned ?? false, finishReason: step.finishReason ?? 'stop',
			...(step.facts !== undefined ? { facts: step.facts } : {}),
		};
	}
}
