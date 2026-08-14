import { describe, expect, it } from 'vitest';
import { resolveTaskModel } from '../../src/core/model-resolution';

describe('resolveTaskModel', () => {
	const verfuegbar = new Set(['gross-27b', 'klein-3b']);

	it('nimmt das Agenten-Modell, wenn der aktive Endpunkt es fuehrt', () => {
		expect(resolveTaskModel('gross-27b', { url: 'http://lm', model: 'zeilen-modell' }, verfuegbar))
			.toBe('gross-27b');
	});

	// Der Kern des Fallbacks: ein Agenten-Modellname ist ein LM-Studio-Name. Auf dem
	// Arbeits-Gateway existiert er nicht — ihn dort zu erzwingen hiesse, den Lauf genau dann
	// zu verweigern, wenn der Fallback gebraucht wird.
	it('faellt auf das Modell der Zeile zurueck, wenn der Endpunkt das Agenten-Modell nicht kennt', () => {
		expect(resolveTaskModel('gross-27b', { url: 'http://gw', model: 'gpt-4o' }, new Set(['gpt-4o'])))
			.toBe('gpt-4o');
	});

	it('nimmt ohne Agenten-Modell direkt das Modell der Zeile', () => {
		expect(resolveTaskModel(null, { url: 'http://gw', model: 'gpt-4o' }, new Set(['gpt-4o'])))
			.toBe('gpt-4o');
	});

	// Der Aufrufer entscheidet ueber model_missing — diese Funktion erfindet nichts.
	it('liefert den leeren String, wenn die Zeile kein Modell traegt', () => {
		expect(resolveTaskModel(null, { url: 'http://gw' }, verfuegbar)).toBe('');
		expect(resolveTaskModel('unbekannt', { url: 'http://gw' }, verfuegbar)).toBe('');
	});

	it('behandelt ein leeres Agenten-Modell wie keines', () => {
		expect(resolveTaskModel('   ', { url: 'http://gw', model: 'gpt-4o' }, new Set(['gpt-4o'])))
			.toBe('gpt-4o');
	});
});
