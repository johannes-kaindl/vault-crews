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
