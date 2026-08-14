/** Migration der Endpunkt-Einstellungen aus dem Alt-Format (Liste roher URL-Strings plus
 *  EIN globales Modellfeld) in das Kit-Format: ein Eintrag je Endpunkt, der URL, Schlüssel
 *  und Modell zusammen trägt.
 *
 *  Warum das globale Modellfeld verschwindet: ein Modellname existiert nur auf dem Endpunkt,
 *  der ihn in `/v1/models` meldet — auf der Nachbarzeile ist er bedeutungslos. Ein globales
 *  Feld plus Override je Zeile wäre dieselbe Information an zwei Orten mit einer Vorrangregel
 *  obendrauf (s. Design 2026-08-14, E1). */
import { migrateEndpointList, type EndpointConfig } from '../vendor/kit/endpoint_config';

/** Was von `data.json` nach dem Settings-Merge ankommt — bewusst `unknown`, weil die Datei
 *  von Hand editierbar ist und alles enthalten kann. */
export interface RawEndpointSettings {
	endpoints?: unknown;
	defaultModel?: unknown;
}

export function migrateEndpointSettings(
	raw: RawEndpointSettings,
	fallback: EndpointConfig[],
): EndpointConfig[] {
	// Der Guard gehört hierher und NICHT in die vendorte Datei: `migrateEndpointList` prüft
	// `list && list.length`, nicht `Array.isArray`. Ein handeditiertes data.json mit einem
	// nicht-leeren String unter `endpoints` reicht dort bis `.map` durch und wirft — was den
	// gesamten Plugin-Load mitreißt ("failed to load plugin"). Gemessen in vim-dojo 2026-08-12.
	if (!Array.isArray(raw.endpoints)) return fallback;

	const migrated = migrateEndpointList(undefined, raw.endpoints as (string | EndpointConfig)[]);
	// Eine leer geräumte Liste ist eine Nutzerentscheidung und wird nicht heimlich gefüllt.
	if (raw.endpoints.length > 0 && migrated.length === 0) return [];

	const globalModel = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '';
	// Trägt schon eine Zeile ein Modell, ist die Migration gelaufen. Ein in data.json
	// zurückgebliebenes `defaultModel` darf dann nichts mehr überschreiben — sonst käme ein
	// abgewähltes Modell beim nächsten Laden zurück.
	if (globalModel === '' || migrated.some((cfg) => (cfg.model ?? '') !== '')) return migrated;

	return migrated.map((cfg) => ({ ...cfg, model: globalModel }));
}
