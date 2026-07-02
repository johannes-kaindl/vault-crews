// Smoke-Tests der vendorten obsidian-kit-Module: sichern die hier genutzten Verträge ab,
// damit ein künftiges manuelles Nachziehen der Vendor-Kopien Abweichungen sofort zeigt.
import { describe, expect, it } from 'vitest';
import { parseSSE } from '../../src/vendor/kit/sse';
import { ThinkSplitter } from '../../src/vendor/kit/think';
import { normalizeEndpoint, resolveActiveEndpoint } from '../../src/vendor/kit/endpoint';
import { defineStrings, setLang, t } from '../../src/vendor/kit/i18n';

describe('vendored parseSSE', () => {
	it('akkumuliert content-Deltas und erkennt [DONE]', () => {
		const buf =
			'data: {"model":"m1","choices":[{"delta":{"content":"Hal"}}]}\n' +
			'data: {"choices":[{"delta":{"content":"lo"}}]}\n' +
			'data: [DONE]\n';
		const r = parseSSE(buf);
		expect(r.content.join('')).toBe('Hallo');
		expect(r.model).toBe('m1');
		expect(r.done).toBe(true);
		expect(r.rest).toBe('');
	});

	it('liefert reasoning_content getrennt und puffert unvollständige Zeilen als rest', () => {
		const buf =
			'data: {"choices":[{"delta":{"reasoning_content":"denk"}}]}\n' +
			'data: {"choices":[{"delta":{"content":"a';
		const r = parseSSE(buf);
		expect(r.reasoning.join('')).toBe('denk');
		expect(r.content).toEqual([]);
		expect(r.rest).toContain('"content":"a');
	});
});

describe('vendored ThinkSplitter', () => {
	it('trennt <think>-Blöcke auch über push-Grenzen hinweg', () => {
		const s = new ThinkSplitter();
		const a = s.push('vor<thi');
		const b = s.push('nk>innen</think>nach');
		const f = s.flush();
		expect(a.content + b.content + f.content).toBe('vornach');
		expect(a.reasoning + b.reasoning + f.reasoning).toBe('innen');
	});
});

describe('vendored endpoint', () => {
	it('normalisiert trailing Slashes und /v1', () => {
		expect(normalizeEndpoint('http://localhost:1234/v1/')).toBe('http://localhost:1234');
		expect(normalizeEndpoint('http://localhost:1234')).toBe('http://localhost:1234');
	});

	it('resolveActiveEndpoint nimmt den ersten pingbaren, normalisiert', async () => {
		const seen: string[] = [];
		const ep = await resolveActiveEndpoint(
			['', 'http://a:1/v1', 'http://b:2'],
			async (e) => { seen.push(e); return e === 'http://b:2'; },
		);
		expect(ep).toBe('http://b:2');
		expect(seen).toEqual(['http://a:1', 'http://b:2']);
	});
});

describe('vendored i18n', () => {
	it('löst Strings pro Sprache mit Platzhaltern auf', () => {
		defineStrings({ en: { greet: 'Hello {0}' }, de: { greet: 'Hallo {0}' } });
		setLang('de');
		expect(t('greet', 'Welt')).toBe('Hallo Welt');
		setLang('en');
		expect(t('greet', 'World')).toBe('Hello World');
	});
});
