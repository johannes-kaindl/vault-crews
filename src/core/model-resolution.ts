/** Welches Modell ein Task tatsächlich anspricht.
 *
 *  Zwei Ebenen, die verschiedene Dinge meinen: Das `model:` eines Agenten ist inhaltlich
 *  gemeint („dieser Analyst braucht ein starkes Modell") und bewegt sich innerhalb EINES
 *  Endpunkts. Das Modell der Endpunkt-Zeile ist infrastrukturell gemeint („auf dieser
 *  Leitung heißen die Modelle so"). Kollidieren sie, gewinnt die Leitung — sonst verweigert
 *  der Lauf genau dann, wenn der Fallback auf einen anderen Anbieter gebraucht wird
 *  (Design 2026-08-14, E3). */
import type { EndpointConfig } from '../vendor/kit/endpoint_config';

export function resolveTaskModel(
	agentModel: string | null,
	active: EndpointConfig,
	available: ReadonlySet<string>,
): string {
	const wunsch = agentModel?.trim() ?? '';
	if (wunsch !== '' && available.has(wunsch)) return wunsch;
	return active.model?.trim() ?? '';
}
