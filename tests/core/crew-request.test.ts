import { describe, it, expect } from 'vitest';
import { buildCrewParams, thinkingLevelFor, MODE } from '../../src/core/crew-request';
import {
	DEFAULT_REQUEST_SETTINGS, resolveRequestParams, resolveThinkingLevel, thinkingLevels,
	type BackendId, type FamilyId, type RequestSettings,
} from '../../src/vendor/kit/sampling-profiles';

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
	// LM Studio ignoriert `none` bei Gemma 4 und legt das Denken ohne Kennung in `content`: der Kit sendet dort die niedrigste Stufe (code-kit 0.28.0).
	'gemma4|lmstudio': { temperature: 0.1, top_p: 0.95, top_k: 64, reasoning_effort: 'low', max_tokens: 2048 },
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

/* Anzeige = Draht (Welle 33, Entscheidung Johannes): der Abschnitt „Request“ rechnet mit dem Modell, das auf den Draht geht
   (`sentModel`), und zeigt die Stufe, die dessen Liste hat. Dieselbe Rechnung gilt für Claude beim Senden; ohne `model` ging bei
   Opus 4.6 `off` als `effort: low` hinaus, während der Abschnitt `high` zeigte. Für alle anderen Familien bleibt es beim alten
   Weg: ein durchgereichtes Modell ändert dort nichts (bis code-kit 0.64.0 hätte es bei gpt-oss `minimal` zu `low` gemacht, goldener Request;
   mit 0.66.0 ist `minimal` die unterste Stufe von gpt-oss und beide Wege stimmen überein). */
describe('Claude: das Modell klemmt die Stufe wie der Abschnitt „Request“', () => {
	const OPUS_46 = 'claude-opus-4-6'; // Liste: low, medium, high, max; Standard high (code-kit 0.63.0, CLAUDE_MODEL_LEVELS)
	const claude = (stored: string, model: string | undefined) =>
		buildCrewParams({
			family: 'claude', backend: 'anthropic', agent: { maxTokens: 2048, thinking: 'auto' },
			settings: settings({ thinking: { [MODE]: stored as never } }), ...(model !== undefined ? { model } : {}),
		});

	it.each([
		['off', 'high'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'max'],
	])('Opus 4.6: gespeichert %s → gesendet effort %s, Stufe im Ergebnis dieselbe', (stored, erwartet) => {
		const { params, thinkingLevel } = claude(stored, OPUS_46);
		expect(params.effort).toBe(erwartet);
		expect(thinkingLevel).toBe(erwartet);
	});

	it('ohne Modell bleibt alles beim Alten (off → effort low), die Gegenprobe zum Test oben', () => {
		expect(claude('off', undefined).params.effort).toBe('low');
	});

	it('ein Claude-Modell mit anderer Liste (Sonnet 4.5) klemmt nach dieser Liste, nicht nach der von Opus 4.6', () => {
		expect(claude('off', 'claude-sonnet-4-5').params.effort).toBe('low');
	});

	it('ein durchgereichtes Modell ändert für die Nicht-Claude-Familien nichts (alle Stufen × Backends × Familien)', () => {
		const stufen = ['off', 'low', 'medium', 'high'] as const;
		let n = 0;
		for (const family of FAMILIES) for (const backend of BACKENDS) for (const stored of stufen) {
			const basis = { family, backend, agent: PERSONA, settings: settings({ thinking: { [MODE]: stored } }) };
			const ohne = buildCrewParams(basis);
			const mit = buildCrewParams({ ...basis, model: 'irgendein-modell' });
			expect(mit, `${family}|${backend}|${stored}`).toEqual(ohne);
			n++;
		}
		expect(n).toBe(FAMILIES.length * BACKENDS.length * stufen.length);
	});
});

/* Anzeige = Draht für JEDE Familie, nicht nur für Claude: so rechnet der Kit-Abschnitt „Request“ (`request-section`): das Modell, das auf den
   Draht geht, klemmt die gespeicherte Stufe (`resolveThinkingLevel`), `resolveRequestParams` bekommt es mit. `buildCrewParams` mit demselben
   `sentModel` muss dieselben Parameter senden. Vor code-kit 0.66.0 war das bei gpt-oss/off nicht so (Abschnitt `low`, Draht `minimal`). */
describe('Anzeige = Draht (Abschnitt „Request“ gegen buildCrewParams)', () => {
	const MODELLE: Record<string, string> = {
		'qwen3.8': 'qwen/qwen3.8-27b', 'qwen3.6': 'qwen3.6-35b', gemma4: 'gemma-4-27b', 'gpt-oss': 'openai/gpt-oss-20b', claude: 'claude-opus-4-6', null: 'irgendein-modell',
	};
	const ALLE_BACKENDS: BackendId[] = ['lmstudio', 'ollama', 'openwebui', 'anthropic', 'openai', 'unknown'];
	const STUFEN = ['off', 'low', 'medium', 'high'] as const;
	const alleFamilien: Family[] = ['qwen3.8', 'qwen3.6', 'gemma4', 'gpt-oss', 'claude', null];

	it('gpt-oss: ein gespeichertes off zeigt minimal (unterste Stufe des Modells) und sendet minimal', () => {
		const model = MODELLE['gpt-oss']!;
		for (const backend of ['lmstudio', 'ollama', 'openwebui', 'openai', 'unknown'] as BackendId[]) {
			expect(thinkingLevels('gpt-oss', backend, model).levels[0], backend).toBe('minimal');
			expect(resolveThinkingLevel('off', 'gpt-oss', backend, model), backend).toBe('minimal');
			const { params } = buildCrewParams({ family: 'gpt-oss', backend, agent: PERSONA, settings: settings(), model });
			expect(params.reasoning_effort, backend).toBe('minimal');
		}
	});

	it('alle Familien × Backends × Stufen: die Rechnung des Abschnitts und buildCrewParams senden dasselbe', () => {
		let n = 0;
		for (const family of alleFamilien) for (const backend of ALLE_BACKENDS) for (const stored of STUFEN) {
			const model = MODELLE[String(family)]!;
			const abschnitt = resolveRequestParams({
				family, mode: MODE, backend, thinking: stored, model, maxTokens: PERSONA.maxTokens,
			}).params;
			const draht = buildCrewParams({
				family, backend, agent: PERSONA, settings: settings({ thinking: { [MODE]: stored } }), model,
			}).params;
			expect(draht, `${family}|${backend}|${stored}`).toEqual(abschnitt);
			n++;
		}
		expect(n).toBe(alleFamilien.length * ALLE_BACKENDS.length * STUFEN.length);
	});
});
