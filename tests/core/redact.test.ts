import { describe, expect, it } from 'vitest';
import { redactRunState, redactSecrets } from '../../src/core/redact';
import type { EndpointConfig } from '../../src/vendor/kit/endpoint_config';

const EPS: EndpointConfig[] = [
	{ url: 'http://localhost:1234/v1' },
	{ url: 'https://gateway.example/v1', apiKey: 'sk-geheim-1234567890' },
];

describe('redactSecrets', () => {
	it('maskiert einen bekannten Schluessel im Klartext', () => {
		expect(redactSecrets('401 für sk-geheim-1234567890 abgelehnt', EPS))
			.toBe('401 für •••• abgelehnt');
	});

	// Auch ohne bekannten Schluessel: ein durchgereichter Header-Echo darf nicht in den Vault.
	it('maskiert Bearer-Token, die gar nicht in den Settings stehen', () => {
		expect(redactSecrets('sent Authorization: Bearer sk-fremd-999 to host', []))
			.toBe('sent Authorization: Bearer •••• to host');
	});

	it('maskiert jedes Vorkommen, auch mehrfach', () => {
		const text = 'sk-geheim-1234567890 und nochmal sk-geheim-1234567890';
		expect(redactSecrets(text, EPS)).toBe('•••• und nochmal ••••');
	});

	// Ein sehr kurzer Schluessel wuerde als Teilstring den halben Text zerlegen — genau das
	// darf nicht passieren, sonst macht die Redaction Fehlermeldungen unlesbar.
	it('ignoriert zu kurze Schluessel, statt den Text zu zerlegen', () => {
		const kurz: EndpointConfig[] = [{ url: 'http://a', apiKey: 'ab' }];
		expect(redactSecrets('das ist ein Absatz ueber abc', kurz)).toBe('das ist ein Absatz ueber abc');
	});

	it('laesst Text ohne Treffer unveraendert', () => {
		expect(redactSecrets('Modell nicht geladen: qwen3-8b', EPS)).toBe('Modell nicht geladen: qwen3-8b');
	});

	it('kommt mit leerem Text und fehlenden Schluesseln klar', () => {
		expect(redactSecrets('', EPS)).toBe('');
		expect(redactSecrets('nichts', [{ url: 'http://a' }])).toBe('nichts');
	});
});

describe('redactRunState', () => {
	it('erwischt Schluessel in beliebig tief liegenden Feldern', () => {
		const state = {
			runId: 'r1',
			tasks: [{ error: 'HTTP 401: key sk-geheim-1234567890 rejected' }],
			nested: { deep: { note: 'Authorization: Bearer sk-fremd-999' } },
		};
		const out = redactRunState(state, EPS);
		expect(out.tasks[0].error).toBe('HTTP 401: key •••• rejected');
		expect(out.nested.deep.note).toBe('Authorization: Bearer ••••');
		expect(out.runId).toBe('r1');
	});
});

// Regression: der Weg ueber die Serialisierung (redactRunState) sucht im JSON-Text, dort steht
// ein `"` als \" und ein Zeilenumbruch als \n. Die Suche nach der ROHFORM findet den Schluessel
// dann nie — es wird nichts ersetzt, das JSON bleibt gueltig, und der Schluessel landet
// unmaskiert in run.md/state.json, also im gesyncten Vault. Kein Fehler, kein Hinweis.
describe('redactRunState mit Schluesseln, die JSON-escapte Zeichen enthalten', () => {
	const faelle: Array<[string, string]> = [
		['doppeltes Anfuehrungszeichen', 'sk-mit"quote-1234567890'],
		['Backslash', 'sk-mit\\slash-1234567890'],
		['Zeilenumbruch', 'sk-mit\nbruch-1234567890'],
		['Tabulator', 'sk-mit\tbreit-1234567890'],
	];

	for (const [name, key] of faelle) {
		it(`maskiert einen Schluessel mit ${name}`, () => {
			const eps: EndpointConfig[] = [{ url: 'https://gw.example/v1', apiKey: key }];
			const state = { tasks: [{ error: `HTTP 401: key ${key} rejected` }] };
			const out = redactRunState(state, eps);
			expect(out.tasks[0].error).toBe('HTTP 401: key •••• rejected');
			expect(JSON.stringify(out)).not.toContain(key);
		});
	}

	// Gegenprobe zur Gegenprobe: JSON.stringify escapt Nicht-ASCII NICHT. Fuer Umlaute, CJK und
	// Emoji traegt allein die Rohform — wer die escapte Form STATT der rohen sucht, bricht hier.
	it('maskiert weiterhin Schluessel mit Nicht-ASCII, die JSON gar nicht escapt', () => {
		const key = 'sk-schlüssel-日本語-1234567890';
		const eps: EndpointConfig[] = [{ url: 'https://gw.example/v1', apiKey: key }];
		const out = redactRunState({ note: `key ${key} rejected` }, eps);
		expect(out.note).toBe('key •••• rejected');
	});

	// Der direkte Aufruf auf UNserialisiertem Text muss unveraendert funktionieren: dort steht
	// der Schluessel roh da, die escapte Nadel griffe daneben.
	it('maskiert denselben Schluessel auch im unserialisierten Direktaufruf', () => {
		const key = 'sk-mit"quote-1234567890';
		const eps: EndpointConfig[] = [{ url: 'https://gw.example/v1', apiKey: key }];
		expect(redactSecrets(`401 fuer ${key} abgelehnt`, eps)).toBe('401 fuer •••• abgelehnt');
	});
});
