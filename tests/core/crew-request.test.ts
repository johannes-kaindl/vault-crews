import { describe, it, expect } from 'vitest';
import { buildCrewParams, thinkingLevelFor, MODE } from '../../src/core/crew-request';
import { DEFAULT_REQUEST_SETTINGS, type BackendId, type FamilyId, type RequestSettings } from '../../src/vendor/kit/sampling-profiles';

/* Goldene Requests: was ein Lauf tatsächlich sendet, je Modellfamilie × Backend. Sie laufen gegen
   `buildCrewParams` — die Request-Bau-Funktion DES PLUGINS mit festem Modus (`structured`) und den drei
   Ebenen Persona > Plugin-Überschreibung > Profil —, nicht gegen `resolveRequestParams` direkt; das prüfte
   das Kit statt das Plugin. Die Erwartungen stammen aus der Profil-Tabelle für `structured` (Temperatur 0.1,
   Denken aus) und wurden an deren Quellen gegengelesen, nicht aus einem Lauf abgeschrieben. */

type Family = FamilyId | null;
const FAMILIES: Family[] = ['qwen3.8', 'qwen3.6', 'gemma4', 'gpt-oss', null];
const BACKENDS: BackendId[] = ['lmstudio', 'openwebui', 'unknown'];
const PERSONA = { maxTokens: 2048, thinking: 'auto' as const };

/** Persona ohne eigene Werte (Default des Parsers: `max_tokens` 2048, `thinking: auto`), Denken aus. */
const OFF: Record<string, Record<string, number | string>> = {
	'qwen3.8|lmstudio': { temperature: 0.1, top_p: 0.8, top_k: 20, min_p: 0, reasoning_effort: 'none', max_tokens: 2048 },
	'qwen3.8|openwebui': { temperature: 0.1, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, reasoning_effort: 'none', max_tokens: 2048 },
	'qwen3.8|unknown': { temperature: 0.1, top_p: 0.8, reasoning_effort: 'none', max_tokens: 2048 },
	'qwen3.6|lmstudio': { temperature: 0.1, top_p: 0.95, top_k: 20, reasoning_effort: 'none', max_tokens: 2048 },
	'qwen3.6|openwebui': { temperature: 0.1, top_p: 0.95, top_k: 20, reasoning_effort: 'none', max_tokens: 2048 },
	'qwen3.6|unknown': { temperature: 0.1, top_p: 0.95, reasoning_effort: 'none', max_tokens: 2048 },
	'gemma4|lmstudio': { temperature: 0.1, top_p: 0.95, top_k: 64, reasoning_effort: 'none', max_tokens: 2048 },
	'gemma4|openwebui': { temperature: 0.1, top_p: 0.95, top_k: 64, reasoning_effort: 'none', max_tokens: 2048 },
	'gemma4|unknown': { temperature: 0.1, top_p: 0.95, reasoning_effort: 'none', max_tokens: 2048 },
	// gpt-oss lässt sich nicht abschalten: die niedrigste Stufe ist „minimal", nie „none".
	'gpt-oss|lmstudio': { temperature: 0.1, top_p: 1, reasoning_effort: 'minimal', max_tokens: 2048 },
	'gpt-oss|openwebui': { temperature: 0.1, top_p: 1, reasoning_effort: 'minimal', max_tokens: 2048 },
	'gpt-oss|unknown': { temperature: 0.1, top_p: 1, reasoning_effort: 'minimal', max_tokens: 2048 },
	// Unbekannte Familie: nur die Temperatur des Modus (plus, was das Backend allein trägt) und das Budget.
	'null|lmstudio': { temperature: 0.1, reasoning_effort: 'none', max_tokens: 2048 },
	'null|openwebui': { temperature: 0.1, reasoning_effort: 'none', max_tokens: 2048 },
	'null|unknown': { temperature: 0.1, max_tokens: 2048 },
};

const settings = (over: Partial<RequestSettings> = {}): RequestSettings => ({ ...structuredClone(DEFAULT_REQUEST_SETTINGS), ...over });

describe('goldene Requests — Persona ohne eigene Werte, Denken aus (Modus structured)', () => {
	const cases = FAMILIES.flatMap((f) => BACKENDS.map((b) => [f, b] as const));
	it('deckt jede Familie × jedes Backend ab', () => {
		expect(Object.keys(OFF).sort()).toEqual(cases.map(([f, b]) => `${f}|${b}`).sort());
	});
	it.each(cases)('%s auf %s', (family, backend) => {
		const { params, thinkingLevel } = buildCrewParams({ family, backend, agent: PERSONA, settings: settings() });
		expect(params).toEqual(OFF[`${family}|${backend}`]);
		expect(thinkingLevel).toBe('off');
	});
});

describe('Persona ist die oberste Ebene', () => {
	it('die Temperatur der Persona schlägt die Überschreibung des Plugins und den Profilwert', () => {
		const s = settings({ overrides: { [MODE]: { 'qwen3.8': { temperature: 0.5 } } } });
		const { params } = buildCrewParams({ family: 'qwen3.8', backend: 'lmstudio', agent: { ...PERSONA, temperature: 0.9 }, settings: s });
		expect(params.temperature).toBe(0.9);
	});
	it('ohne Persona-Temperatur gilt die Überschreibung des Plugins, ohne beide der Profilwert', () => {
		const s = settings({ overrides: { [MODE]: { 'qwen3.8': { temperature: 0.5 } } } });
		expect(buildCrewParams({ family: 'qwen3.8', backend: 'lmstudio', agent: PERSONA, settings: s }).params.temperature).toBe(0.5);
		expect(buildCrewParams({ family: 'qwen3.8', backend: 'lmstudio', agent: PERSONA, settings: settings() }).params.temperature).toBe(0.1);
	});
	it('eine Überschreibung gilt nur für ihre Familie', () => {
		const s = settings({ overrides: { [MODE]: { 'qwen3.8': { temperature: 0.5 } } } });
		expect(buildCrewParams({ family: 'gemma4', backend: 'lmstudio', agent: PERSONA, settings: s }).params.temperature).toBe(0.1);
	});
	it('max_tokens der Persona ist das Budget des Plugins', () => {
		expect(buildCrewParams({ family: 'gemma4', backend: 'lmstudio', agent: { ...PERSONA, maxTokens: 4096 }, settings: settings() }).params.max_tokens).toBe(4096);
	});
});

describe('Denkstufe: thinking der Persona gegen die Wahl des Plugins', () => {
	it('auto → die Wahl des Plugins, sonst die Modusvorgabe (off)', () => {
		expect(thinkingLevelFor({ thinking: 'auto' }, settings())).toBe('off');
		expect(thinkingLevelFor({ thinking: 'auto' }, settings({ thinking: { [MODE]: 'high' } }))).toBe('high');
	});
	it('off → off, auch wenn das Plugin eine Stufe gewählt hat', () => {
		expect(thinkingLevelFor({ thinking: 'off' }, settings({ thinking: { [MODE]: 'high' } }))).toBe('off');
	});
	it('on → fest medium (nicht die „an"-Stufe des Modus, die für structured low wäre)', () => {
		expect(thinkingLevelFor({ thinking: 'on' }, settings())).toBe('medium');
		expect(thinkingLevelFor({ thinking: 'on' }, settings({ thinking: { [MODE]: 'low' } }))).toBe('medium');
	});
	it('thinking: on hebt das Budget auf die Reserve der Familie und sendet die Stufe', () => {
		const { params } = buildCrewParams({ family: 'qwen3.8', backend: 'lmstudio', agent: { maxTokens: 1024, thinking: 'on' }, settings: settings() });
		expect(params).toMatchObject({ reasoning_effort: 'medium', max_tokens: 2048 });
	});
});

describe('gpt-oss-Wächter (früher in local-llm-client.test.ts, Fix 3394839)', () => {
	it('bekommt nie reasoning_effort "none" — der Server lehnt es mit HTTP 400 ab', () => {
		for (const backend of BACKENDS) {
			for (const thinking of ['auto', 'off'] as const) {
				const { params } = buildCrewParams({ family: 'gpt-oss', backend, agent: { maxTokens: 2048, thinking }, settings: settings() });
				expect(params.reasoning_effort).not.toBe('none');
			}
		}
	});
});
