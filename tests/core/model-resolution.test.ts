import { describe, expect, it } from 'vitest';
import { describeCrewModels, resolveTaskModel } from '../../src/core/model-resolution';
import type { AgentDef } from '../../src/core/types';

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

// Die Anzeige im Panel sagt, welches Modell und welche Denkstufe jeder Agent einer Crew bekommt. Das wirkliche Modell steht erst zur Laufzeit
// fest (der aktive Endpunkt wird dort angepingt, seine Liste dort gelesen); das Panel fragt nicht. Darum kennt die Funktion `available === null`
// („nicht gefragt") und sagt dann ehrlich zweistufig: Wunsch, wenn der Endpunkt ihn führt, sonst das Modell der Zeile.
function agent(over: Partial<AgentDef> = {}): AgentDef {
	return { id: 'analyst', name: 'Analyst', model: null, maxTokens: 2048, thinking: 'auto', systemPrompt: 'x', ...over };
}
const task = (a: AgentDef, taskId = 'analyse') => ({ taskId, agent: a });
const ROW = 'zeilen-modell';

describe('describeCrewModels', () => {
	it('Agenten-Modell, das der Endpunkt führt: source agent', () => {
		const [r] = describeCrewModels([task(agent({ model: 'gross-27b' }))], ROW, new Set(['gross-27b', ROW]));
		expect(r).toMatchObject({ taskId: 'analyse', agentId: 'analyst', agentName: 'Analyst', wanted: 'gross-27b', effective: 'gross-27b', source: 'agent' });
	});

	it('Agenten-Modell, das der Endpunkt nicht führt: Rückfall auf die Zeile, wanted bleibt sichtbar', () => {
		const [r] = describeCrewModels([task(agent({ model: 'gross-27b' }))], ROW, new Set([ROW]));
		expect(r).toMatchObject({ wanted: 'gross-27b', effective: ROW, source: 'endpoint' });
	});

	it('ohne Agenten-Modell: das Modell der Zeile, wanted ist null', () => {
		const [r] = describeCrewModels([task(agent())], ROW, new Set([ROW]));
		expect(r).toMatchObject({ wanted: null, effective: ROW, source: 'endpoint' });
	});

	it('Zeile ohne Modell und kein Wunsch: source none (der Lauf bräche mit model_missing ab)', () => {
		const [r] = describeCrewModels([task(agent())], '', new Set());
		expect(r).toMatchObject({ wanted: null, effective: '', source: 'none' });
		const [leer] = describeCrewModels([task(agent())], '   ', null);
		expect(leer?.source).toBe('none');
	});

	it('trägt die Denkstufe des Agenten durch: off, on, auto', () => {
		const rows = describeCrewModels([task(agent({ thinking: 'off' }), 'a'), task(agent({ thinking: 'on' }), 'b'), task(agent({ thinking: 'auto' }), 'c')], ROW, null);
		expect(rows.map((r) => r.thinking)).toEqual(['off', 'on', 'auto']);
	});

	it('nicht gefragt (available null), Wunsch gesetzt: conditional, effective ist das Modell der Zeile', () => {
		const [r] = describeCrewModels([task(agent({ model: 'gross-27b' }))], ROW, null);
		expect(r).toMatchObject({ wanted: 'gross-27b', effective: ROW, fallback: ROW, source: 'conditional' });
	});

	it('nicht gefragt, kein Wunsch: das Modell der Zeile gilt sicher (source endpoint)', () => {
		const [r] = describeCrewModels([task(agent())], ROW, null);
		expect(r).toMatchObject({ wanted: null, effective: ROW, source: 'endpoint' });
	});

	it('Endpoint Manager entscheidet (endpointModel null): ohne Wunsch managed, mit Wunsch conditional ohne bekanntes Modell der Zeile', () => {
		const [a] = describeCrewModels([task(agent())], null, null);
		expect(a).toMatchObject({ wanted: null, fallback: null, effective: '', source: 'managed' });
		const [b] = describeCrewModels([task(agent({ model: 'gross-27b' }))], null, null);
		expect(b).toMatchObject({ wanted: 'gross-27b', fallback: null, source: 'conditional' });
	});

	it('eine Crew ohne llm-Task ergibt keine Zeilen und keinen Fehler', () => {
		expect(describeCrewModels([], ROW, null)).toEqual([]);
	});

	it('eine Zeile je llm-Task, in der Reihenfolge der Crew (derselbe Agent zweimal ergibt zwei Zeilen)', () => {
		const a = agent({ model: 'gross-27b' });
		const rows = describeCrewModels([task(a, 'erst'), task(agent({ id: 'zweiter', name: 'Zweiter' }), 'dann'), task(a, 'nochmal')], ROW, new Set(['gross-27b']));
		expect(rows.map((r) => [r.taskId, r.agentId, r.source])).toEqual([['erst', 'analyst', 'agent'], ['dann', 'zweiter', 'endpoint'], ['nochmal', 'analyst', 'agent']]);
	});

	// Gegen eine eigene Auflösungslogik neben `resolveTaskModel`: die beiden müssen für jede Eingabe dasselbe Modell nennen.
	it('nennt für jede Eingabe dasselbe Modell wie resolveTaskModel', () => {
		for (const wanted of [null, '', 'gross-27b', 'klein-3b']) {
			for (const row of ['', ROW, 'gross-27b']) {
				for (const avail of [new Set<string>(), new Set(['gross-27b']), new Set(['klein-3b', row])]) {
					const [r] = describeCrewModels([task(agent({ model: wanted }))], row, avail);
					expect(r?.effective, `${wanted} ${row} ${[...avail]}`).toBe(resolveTaskModel(wanted, { url: 'x', model: row }, avail));
				}
			}
		}
	});
});
