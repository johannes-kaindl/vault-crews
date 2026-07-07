import { describe, expect, it } from 'vitest';
import {
	parseLmStudioContext, parseOllamaContext, suppressParams, isAlwaysOnThinker,
} from '../../src/core/model-info';

describe('parseLmStudioContext', () => {
	const json = { data: [
		{ id: 'qwen3-8b', max_context_length: 32768, loaded_context_length: 8192 },
		{ id: 'other', max_context_length: 4096 },
	] };
	it('liest loaded + max für das getroffene Modell', () => {
		expect(parseLmStudioContext(json, 'qwen3-8b')).toEqual({ maxContextLength: 32768, loadedContextLength: 8192 });
	});
	it('gibt null bei fehlendem Modell', () => {
		expect(parseLmStudioContext(json, 'missing')).toBeNull();
	});
	it('gibt null bei nicht-Array data', () => {
		expect(parseLmStudioContext({ data: 'x' }, 'a')).toBeNull();
	});
});

describe('parseOllamaContext', () => {
	it('liest <arch>.context_length aus model_info', () => {
		expect(parseOllamaContext({ model_info: { 'qwen3.context_length': 40960, 'general.name': 'q' } }))
			.toEqual({ maxContextLength: 40960 });
	});
	it('gibt null wenn kein *.context_length vorhanden', () => {
		expect(parseOllamaContext({ model_info: { 'general.name': 'q' } })).toBeNull();
	});
	it('gibt null bei fehlendem model_info', () => {
		expect(parseOllamaContext({})).toBeNull();
	});
});

describe('suppressParams', () => {
	it('leeres Objekt wenn nicht unterdrückt', () => {
		expect(suppressParams(false)).toEqual({});
	});
	it('Union-Params (reasoning_effort String "none", nie Boolean)', () => {
		expect(suppressParams(true)).toEqual({
			reasoning_effort: 'none',
			chat_template_kwargs: { enable_thinking: false },
			reasoning_budget: 0,
		});
	});
});

describe('isAlwaysOnThinker', () => {
	it('erkennt gpt-oss und harmony', () => {
		expect(isAlwaysOnThinker('gpt-oss-20b')).toBe(true);
		expect(isAlwaysOnThinker('some-harmony-model')).toBe(true);
	});
	it('false für generische Modelle', () => {
		expect(isAlwaysOnThinker('qwen3-8b')).toBe(false);
	});
});
