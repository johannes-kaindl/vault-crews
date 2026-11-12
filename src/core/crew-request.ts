/** Die Request-Bau-Funktion DES PLUGINS: nur sie kennt den festen Modus (`structured`) und die
 *  drei Ebenen, die hier zusammenkommen. Goldene Requests laufen dagegen, nicht gegen
 *  `resolveRequestParams` direkt — sonst prüfte der Test das Kit statt das Plugin.
 *
 *  Reihenfolge der Quellen, von oben nach unten wirksam:
 *    1. Persona-Frontmatter (`temperature`, `max_tokens`, `thinking`) — die Persona ist der
 *       bewusste Eingriff für genau diesen Agenten;
 *    2. Plugin-Überschreibung je Modus × Modellfamilie (Abschnitt „Anfrage");
 *    3. Profil-Tabelle des Kits (Modus `structured`: Temperatur 0.1, Denken aus).
 *  Verträge sind Prosa + `validate()` (kein `json_schema`), deshalb ist `structured` der Modus:
 *  Ablauf steht vorher fest, das Modell füllt nur schema-validierte Verträge. */
import {
	resolveRequestParams, resolveThinkingLevel, thinkingFor,
	type BackendId, type FamilyId, type FieldId, type RequestSettings, type ThinkingLevel,
} from '../vendor/kit/sampling-profiles';
import type { AgentDef } from './types';

export const MODE = 'structured';

/** `thinking: on` heißt in der Persona „der Agent soll denken", nicht „wie der Modus es will":
 *  fest `medium`. `onLevelFor` liefe für `structured` auf `low` (Modusstufe ist `off`) und wäre
 *  damit eine andere Zusage als die, die der Nutzer in die Persona geschrieben hat. */
const PERSONA_ON_LEVEL: ThinkingLevel = 'medium';

export function thinkingLevelFor(agent: Pick<AgentDef, 'thinking'>, settings: RequestSettings): ThinkingLevel {
	if (agent.thinking === 'on') return PERSONA_ON_LEVEL;
	if (agent.thinking === 'off') return 'off';
	return thinkingFor(settings, MODE); // auto: die Wahl des Plugins, sonst die Modusvorgabe (off)
}

/** `model` ist das Modell, das auf den Draht geht (`sentModel`). Es zählt nur bei Claude: dort hängt die Liste der Stufen am Modell
 *  (Opus 4.6: low, medium, high, max; ein gespeichertes `off` heißt „keine eigene Wahl“ und wird zum Standard des Modells), und der Abschnitt
 *  „Request“ rechnet mit demselben Modell. Bei den lokalen Familien bliebe `model` ohne Nutzen und würde nur `off` auf gpt-oss von
 *  `minimal` auf `low` heben (goldener Request), deshalb geht es dort nicht in die Rechnung. */
export function buildCrewParams(input: {
	family: FamilyId | null;
	backend: BackendId;
	agent: Pick<AgentDef, 'temperature' | 'maxTokens' | 'thinking'>;
	settings: RequestSettings;
	model?: string;
}): { params: Record<string, number | string>; thinkingLevel: ThinkingLevel } {
	const wanted = thinkingLevelFor(input.agent, input.settings);
	const modelPart = input.family === 'claude' && input.model !== undefined && input.model !== '' ? { model: input.model } : {};
	const thinkingLevel = 'model' in modelPart ? resolveThinkingLevel(wanted, input.family, input.backend, modelPart.model) : wanted;
	const fromPlugin = input.settings.overrides[MODE]?.[input.family ?? 'unknown'] ?? {};
	const overrides: Partial<Record<FieldId, number | string>> = {
		...fromPlugin,
		...(input.agent.temperature !== undefined ? { temperature: input.agent.temperature } : {}),
	};
	const { params } = resolveRequestParams({
		family: input.family, mode: MODE, backend: input.backend, thinking: thinkingLevel,
		maxTokens: input.agent.maxTokens, overrides, ...modelPart,
	});
	return { params, thinkingLevel };
}
