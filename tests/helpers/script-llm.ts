import type { LlmClient, LlmMessage, LlmParams, LlmStreamResult, ModelInfo } from '../../src/core/ports';
import { LlmCallError } from '../../src/core/ports';

export interface ScriptedCall {
	content?: string;
	thinkTokens?: number;
	finishReason?: LlmStreamResult['finishReason'];
	/** Fehlerinjektion statt Antwort. */
	error?: 'overflow' | 'timeout' | 'stalled' | 'http';
}

export class ScriptLlmClient implements LlmClient {
	readonly calls: { messages: LlmMessage[]; params: LlmParams }[] = [];
	readonly baseCalls: string[] = [];
	constructor(private queue: ScriptedCall[], private ctxLength: number | null = 8192) {}

	async ping(_endpoint?: string): Promise<boolean> { return true; }
	setBase(endpoint: string): void { this.baseCalls.push(endpoint); }
	async listModels(): Promise<string[]> { return ['test-model']; }
	async modelInfo(model: string): Promise<ModelInfo | null> { return { id: model, contextLength: this.ctxLength }; }

	async stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string) => void, _signal: AbortSignal): Promise<LlmStreamResult> {
		this.calls.push({ messages, params });
		const step = this.queue.shift();
		if (!step) throw new Error('ScriptLlmClient: Queue leer — Test hat mehr Calls gemacht als gescriptet');
		if (step.error) throw new LlmCallError(`injected: ${step.error}`, step.error);
		const content = step.content ?? '';
		for (const chunk of content.match(/.{1,8}/gs) ?? []) onToken(chunk);
		return { content, thinkTokens: step.thinkTokens ?? 0, finishReason: step.finishReason ?? 'stop' };
	}
}
