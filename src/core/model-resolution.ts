/** Welches Modell ein Task tatsächlich anspricht.
 *
 *  Zwei Ebenen, die verschiedene Dinge meinen: Das `model:` eines Agenten ist inhaltlich
 *  gemeint („dieser Analyst braucht ein starkes Modell") und bewegt sich innerhalb EINES
 *  Endpunkts. Das Modell der Endpunkt-Zeile ist infrastrukturell gemeint („auf dieser
 *  Leitung heißen die Modelle so"). Kollidieren sie, gewinnt die Leitung — sonst verweigert
 *  der Lauf genau dann, wenn der Fallback auf einen anderen Anbieter gebraucht wird
 *  (Design 2026-08-14, E3). */
import type { EndpointConfig } from '../vendor/kit/endpoint_config';
import type { AgentDef } from './types';

export function resolveTaskModel(
	agentModel: string | null,
	active: EndpointConfig,
	available: ReadonlySet<string>,
): string {
	const wunsch = agentModel?.trim() ?? '';
	if (wunsch !== '' && available.has(wunsch)) return wunsch;
	return active.model?.trim() ?? '';
}

/** Woher das Modell eines Tasks kommt, wie das Panel es anzeigt. `conditional`: der Agent wünscht ein Modell, ob der aktive Endpunkt es führt, steht
 *  erst zur Laufzeit fest (das Panel pingt nicht) — die Anzeige nennt dann beide Stufen. `managed`: der Endpoint Manager entscheidet beim Start, das
 *  Modell der Zeile ist noch nicht bekannt. */
export type CrewModelSource = 'agent' | 'endpoint' | 'conditional' | 'none' | 'managed';

export interface CrewModelRow {
	taskId: string;
	agentId: string;
	agentName: string;
	/** Das `model:` der Persona, sonst null. */
	wanted: string | null;
	/** Modell der Endpunkt-Zeile (der Rückfall); null, solange der Endpoint Manager es beim Start entscheidet. */
	fallback: string | null;
	/** Das Modell, das der Task bekommt; bei `conditional` und `managed` der Rückfall (leer, wenn der noch unbekannt oder nicht gewählt ist). */
	effective: string;
	source: CrewModelSource;
	thinking: AgentDef['thinking'];
}

/** Je `llm`-Task einer Crew das Modell und die Denkstufe, die der Agent bekommt — für die nur lesende Anzeige im Lauf-Panel. Keine eigene Auflösung neben
 *  `resolveTaskModel`: wo die Liste des Endpunkts bekannt ist (`available`), ruft sie sie; wo nicht (`null`, das Panel fragt den Endpunkt nie), zeigt sie
 *  den Wunsch und den Rückfall und sagt nicht, welcher gilt. `endpointModel` null heißt: der Endpoint Manager wählt beim Start. */
export function describeCrewModels(
	tasks: ReadonlyArray<{ taskId: string; agent: AgentDef }>,
	endpointModel: string | null,
	available: ReadonlySet<string> | null,
): CrewModelRow[] {
	const fallback = endpointModel === null ? null : endpointModel.trim();
	const row: EndpointConfig = fallback === null || fallback === '' ? { url: '' } : { url: '', model: fallback };
	return tasks.map(({ taskId, agent }) => {
		const wanted = agent.model?.trim() ? agent.model.trim() : null;
		const base = { taskId, agentId: agent.id, agentName: agent.name, wanted, fallback, thinking: agent.thinking };
		if (available !== null) {
			const effective = resolveTaskModel(wanted, row, available);
			const source: CrewModelSource = effective === ''
				? (fallback === null ? 'managed' : 'none')
				: wanted !== null && available.has(wanted) ? 'agent' : 'endpoint';
			return { ...base, effective, source };
		}
		if (wanted === null) {
			return { ...base, effective: fallback ?? '', source: fallback === null ? 'managed' : fallback === '' ? 'none' : 'endpoint' };
		}
		return { ...base, effective: resolveTaskModel(wanted, row, new Set()), source: 'conditional' };
	});
}
