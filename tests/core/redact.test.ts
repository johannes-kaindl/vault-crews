import { describe, expect, it } from 'vitest';
import { redactKeys, redactKeysInValue } from '../../src/vendor/kit/redact';
import type { EndpointConfig } from '../../src/vendor/kit/endpoint_config';

// Die Schwärzung selbst kommt aus dem Kit (code-kit `redact`); diese Fälle halten fest, was
// vault-crews von ihr verlangt, so wie der Orchestrator sie ruft: Schlüssel = apiKey der
// hydrierten Endpunkte.
const EPS: EndpointConfig[] = [
	{ url: 'http://localhost:1234/v1' },
	{ url: 'https://gateway.example/v1', apiKey: 'sk-geheim-1234567890' },
];
const keys = (eps: EndpointConfig[]): (string | undefined)[] => eps.map((e) => e.apiKey);

describe('redactKeys', () => {
	it('maskiert einen bekannten Schluessel im Klartext', () => {
		expect(redactKeys('401 für sk-geheim-1234567890 abgelehnt', keys(EPS))).toBe('401 für •••• abgelehnt');
	});

	// Auch ohne bekannten Schluessel: ein durchgereichter Header-Echo darf nicht in den Vault.
	it('maskiert Bearer-Token, die gar nicht in den Settings stehen', () => {
		expect(redactKeys('sent Authorization: Bearer sk-fremd-999 to host', [])).toBe('sent Authorization: Bearer •••• to host');
	});

	it('maskiert jedes Vorkommen, auch mehrfach', () => {
		expect(redactKeys('sk-geheim-1234567890 und nochmal sk-geheim-1234567890', keys(EPS))).toBe('•••• und nochmal ••••');
	});

	// Ein sehr kurzer Schluessel wuerde als Teilstring den halben Text zerlegen.
	it('ignoriert zu kurze Schluessel, statt den Text zu zerlegen', () => {
		expect(redactKeys('das ist ein Absatz ueber abc', ['ab'])).toBe('das ist ein Absatz ueber abc');
	});

	it('laesst Text ohne Treffer unveraendert und kommt mit leerem Text und fehlenden Schluesseln klar', () => {
		expect(redactKeys('Modell nicht geladen: qwen3-8b', keys(EPS))).toBe('Modell nicht geladen: qwen3-8b');
		expect(redactKeys('', keys(EPS))).toBe('');
		expect(redactKeys('nichts', [undefined])).toBe('nichts');
	});

	// Verhaltenswechsel gegenueber der alten Fassung (Kit 0.18.0): ist Schluessel A Praefix von B,
	// blieb frueher der Rest von B stehen.
	it('maskiert einen Schluessel ganz, auch wenn ein anderer sein Praefix ist', () => {
		const out = redactKeys('key sk-praefix-12345678-SECRETSUFFIX99 rejected', ['sk-praefix-12345678', 'sk-praefix-12345678-SECRETSUFFIX99']);
		expect(out).toBe('key •••• rejected');
		expect(out).not.toContain('SECRETSUFFIX99');
	});
});

describe('redactKeysInValue', () => {
	it('erwischt Schluessel in beliebig tief liegenden Feldern', () => {
		const state = {
			runId: 'r1',
			tasks: [{ error: 'HTTP 401: key sk-geheim-1234567890 rejected' }],
			nested: { deep: { note: 'Authorization: Bearer sk-fremd-999' } },
		};
		const out = redactKeysInValue(state, keys(EPS));
		expect(out.tasks[0]?.error).toBe('HTTP 401: key •••• rejected');
		expect(out.nested.deep.note).toBe('Authorization: Bearer ••••');
		expect(out.runId).toBe('r1');
	});

	// Der Weg ueber die Serialisierung sucht im JSON-Text: dort steht ein `"` als \" und ein
	// Zeilenumbruch als \n. Ohne die escapte Nadel bliebe der Schluessel unmaskiert im Vault.
	const faelle: Array<[string, string]> = [
		['doppeltes Anfuehrungszeichen', 'sk-mit"quote-1234567890'],
		['Backslash', 'sk-mit\\slash-1234567890'],
		['Zeilenumbruch', 'sk-mit\nbruch-1234567890'],
		['Tabulator', 'sk-mit\tbreit-1234567890'],
	];
	for (const [name, key] of faelle) {
		it(`maskiert einen Schluessel mit ${name}`, () => {
			const out = redactKeysInValue({ tasks: [{ error: `HTTP 401: key ${key} rejected` }] }, [key]);
			expect(out.tasks[0]?.error).toBe('HTTP 401: key •••• rejected');
			expect(JSON.stringify(out)).not.toContain(key);
		});
	}

	// JSON.stringify escapt Nicht-ASCII NICHT: dort traegt allein die Rohform.
	it('maskiert weiterhin Schluessel mit Nicht-ASCII', () => {
		const key = 'sk-schlüssel-日本語-1234567890';
		expect(redactKeysInValue({ note: `key ${key} rejected` }, [key]).note).toBe('key •••• rejected');
	});

	it('maskiert denselben Schluessel auch im unserialisierten Direktaufruf', () => {
		const key = 'sk-mit"quote-1234567890';
		expect(redactKeys(`401 fuer ${key} abgelehnt`, [key])).toBe('401 fuer •••• abgelehnt');
	});

	// Fail-closed (Kit): ein Zustand ohne JSON-Abbild wirft, statt Ungeschwaerztes durchzulassen.
	it('wirft bei zirkulaerem Zustand', () => {
		const state: { self?: unknown } = {};
		state.self = state;
		expect(() => redactKeysInValue(state, keys(EPS))).toThrow();
	});
});
