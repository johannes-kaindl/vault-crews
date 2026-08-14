import { describe, expect, it } from 'vitest';
import { migrateEndpointSettings } from '../../src/core/endpoint-settings';
import type { EndpointConfig } from '../../src/vendor/kit/endpoint_config';

const FALLBACK: EndpointConfig[] = [{ url: 'http://localhost:1234/v1' }];

describe('migrateEndpointSettings', () => {
	it('macht aus der alten String-Liste Endpunkt-Eintraege', () => {
		expect(migrateEndpointSettings({ endpoints: ['http://a', 'http://b'] }, FALLBACK))
			.toEqual([{ url: 'http://a' }, { url: 'http://b' }]);
	});

	it('verteilt ein altes globales Modell auf alle Zeilen', () => {
		expect(migrateEndpointSettings({ endpoints: ['http://a', 'http://b'], defaultModel: 'qwen3-8b' }, FALLBACK))
			.toEqual([
				{ url: 'http://a', model: 'qwen3-8b' },
				{ url: 'http://b', model: 'qwen3-8b' },
			]);
	});

	// Sonst holt ein in data.json zurueckgebliebenes defaultModel ein Modell zurueck, das
	// der Nutzer in der Zeile bewusst geaendert hat. Traegt IRGENDEINE Zeile ein Modell,
	// ist die Migration erkennbar gelaufen.
	it('ignoriert das alte globale Modell, sobald eine Zeile ein eigenes traegt', () => {
		expect(migrateEndpointSettings(
			{ endpoints: [{ url: 'http://a', model: 'gewaehlt' }, { url: 'http://b' }], defaultModel: 'alt' },
			FALLBACK,
		)).toEqual([{ url: 'http://a', model: 'gewaehlt' }, { url: 'http://b' }]);
	});

	it('laesst eine bereits migrierte Liste in Ruhe', () => {
		const eps = [{ url: 'http://a', apiKey: 'k', model: 'm' }];
		expect(migrateEndpointSettings({ endpoints: eps }, FALLBACK)).toEqual(eps);
	});

	it('behaelt eine leer geraeumte Liste — das ist eine Nutzerentscheidung', () => {
		expect(migrateEndpointSettings({ endpoints: [] }, FALLBACK)).toEqual([]);
	});

	// Falle (5) des Kit-Rollouts: ein handeditiertes data.json mit einem String statt eines
	// Arrays reicht bis .map/.filter im Kit durch und wirft — was den ganzen Plugin-Load
	// mitreisst ("failed to load plugin"). Der Guard gehoert an den Aufrufer-Rand, nicht in
	// die vendorte Datei.
	it('faengt ein kaputtes data.json ab, statt den Plugin-Load mitzureissen', () => {
		expect(migrateEndpointSettings({ endpoints: 'http://a' }, FALLBACK)).toEqual(FALLBACK);
		expect(migrateEndpointSettings({ endpoints: null }, FALLBACK)).toEqual(FALLBACK);
		expect(migrateEndpointSettings({}, FALLBACK)).toEqual(FALLBACK);
	});

	it('wirft Eintraege weg, die weder String noch Objekt mit url sind', () => {
		expect(migrateEndpointSettings({ endpoints: ['http://a', 42, null, { kein: 'url' }] }, FALLBACK))
			.toEqual([{ url: 'http://a' }]);
	});
});
