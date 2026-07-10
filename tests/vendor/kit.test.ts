// Smoke-Tests der vendorten obsidian-kit-Module: sichern die hier genutzten Verträge ab,
// damit ein künftiges manuelles Nachziehen der Vendor-Kopien Abweichungen sofort zeigt.
import { describe, expect, it } from 'vitest';
import { parseSSE } from '../../src/vendor/kit/sse';
import { ThinkSplitter } from '../../src/vendor/kit/think';
import { normalizeEndpoint, parseEndpointList, resolveActiveEndpoint } from '../../src/vendor/kit/endpoint';
import {
	ENDPOINT_PRESETS,
	classifyEndpointStatus,
	validateEndpointInput,
} from '../../src/vendor/kit/endpoint_diagnostics';
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

	it('parseEndpointList trimmt, dedupliziert und lässt Leerzeilen weg', () => {
		expect(parseEndpointList('http://a:1\n http://b:2 \n\nhttp://a:1')).toEqual([
			'http://a:1',
			'http://b:2',
		]);
	});
});

describe('vendored endpoint_diagnostics', () => {
	it('classify: 200 mit {data:[]} ist ok', () => {
		const s = classifyEndpointStatus({ kind: 'response', status: 200, body: { data: [] } });
		expect(s.kind).toBe('ok');
		expect(s.reachable).toBe(true);
	});

	it('classify: 200 ohne data-Liste ist not-an-llm-api', () => {
		const s = classifyEndpointStatus({ kind: 'response', status: 200, body: { hello: 1 } });
		expect(s.kind).toBe('not-an-llm-api');
		expect(s.reachable).toBe(false);
	});

	it('classify: ECONNREFUSED ist refused', () => {
		expect(classifyEndpointStatus({ kind: 'error', message: 'connect ECONNREFUSED 127.0.0.1:1234' }).kind).toBe(
			'refused',
		);
	});

	it('classify: ENOTFOUND ist unknown-host', () => {
		expect(classifyEndpointStatus({ kind: 'error', message: 'getaddrinfo ENOTFOUND nope' }).kind).toBe(
			'unknown-host',
		);
	});

	it('classify: timeout-Signal ist timeout', () => {
		expect(classifyEndpointStatus({ kind: 'timeout' }).kind).toBe('timeout');
	});

	it('classify: unbekannter Fehler behält die rohe Meldung', () => {
		const s = classifyEndpointStatus({ kind: 'error', message: 'weird boom' });
		expect(s.kind).toBe('unknown');
		expect(s.raw).toBe('weird boom');
	});

	it('ENDPOINT_PRESETS enthält LM Studio und Ollama', () => {
		expect(ENDPOINT_PRESETS.map((p) => p.label)).toEqual(['LM Studio', 'Ollama']);
	});

	it('validateEndpointInput warnt bei fehlendem Schema und fehlendem Port', () => {
		expect(validateEndpointInput('localhost:1234').map((w) => w.rule)).toContain('scheme');
		expect(validateEndpointInput('http://localhost').map((w) => w.rule)).toContain('port');
		expect(validateEndpointInput('http://localhost:1234')).toEqual([]);
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
