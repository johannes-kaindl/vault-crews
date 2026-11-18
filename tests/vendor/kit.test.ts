// Smoke-Tests der vendorten obsidian-kit-Module: sichern die hier genutzten Verträge ab,
// damit ein künftiges manuelles Nachziehen der Vendor-Kopien Abweichungen sofort zeigt.
import { describe, expect, it } from 'vitest';
import { parseSSE } from '../../src/vendor/kit/sse';
import { ThinkSplitter } from '../../src/vendor/kit/think-splitter';
import { normalizeEndpoint, parseEndpointList, resolveActiveEndpoint } from '../../src/vendor/kit/endpoint';
import {
	ENDPOINT_PRESETS,
	classifyEndpointStatus,
	validateEndpointInput,
} from '../../src/vendor/kit/endpoint_diagnostics';
import { defineStrings, setLang, t } from '../../src/vendor/kit/i18n';
import { realClock } from '../../src/vendor/kit/clock';
import {
	applyEndpointEdit, authHeaders, carriesApiKey, endpointRole,
	migrateEndpointList, moveEndpointToFront, resolveActiveEndpointConfig,
} from '../../src/vendor/kit/endpoint_config';
import type { EndpointConfig } from '../../src/vendor/kit/endpoint_config';
import { resolveModelChoice } from '../../src/vendor/kit/model-choice';
import { createModelListCache } from '../../src/vendor/kit/model-list-cache';
import { extractModelIds } from '../../src/vendor/kit/endpoint_diagnostics';
import { withTimeout } from '../../src/vendor/kit/timeout';
import { guessFromName, resolveCapabilities } from '../../src/vendor/kit/capabilities';
import { errorMessageFromBody, errorMessageFromText } from '../../src/vendor/kit/error_body';
import { parseFrontmatter, serializeFrontmatter, wikilinkDisplayText, wikilinkOf } from '../../src/vendor/kit/frontmatter';
import { baseName } from '../../src/vendor/kit/rel-path';
import { errorMessage } from '../../src/vendor/kit/error-message';
import { resolveEndpointSource } from '../../src/vendor/kit/endpoint-source';
import type { ApiEndpoint, LlmEndpointManagerApi, ResolvedEndpoint } from '../../src/vendor/kit/endpoint-source';
import { gunzipText, gzipText } from '../../src/vendor/kit/gzip-text';
import { recordingTransport } from '../../src/vendor/kit/recording-transport';
import type { SseTransport } from '../../src/vendor/kit/chat-client';
import type { TransportExchange } from '../../src/vendor/kit/recording-transport';

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

	it('liest finish_reason aus dem letzten Chunk und ignoriert die null-Zwischenwerte', () => {
		const buf =
			'data: {"choices":[{"delta":{"content":"abge"},"finish_reason":null}]}\n' +
			'data: {"choices":[{"delta":{"content":"schnitten"},"finish_reason":"length"}]}\n' +
			'data: [DONE]\n';
		const r = parseSSE(buf);
		expect(r.finishReason).toBe('length');
		expect(r.content.join('')).toBe('abgeschnitten');
	});

	it('laesst finishReason undefiniert, solange kein Chunk einen nennt', () => {
		const r = parseSSE('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n');
		expect(r.finishReason).toBeUndefined();
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

describe('vendored clock', () => {
	it('now() liefert die Wall-Clock', () => {
		const before = Date.now();
		const seen = realClock.now();
		expect(seen).toBeGreaterThanOrEqual(before);
		expect(seen).toBeLessThanOrEqual(Date.now());
	});

	// Der ganze Zweck des Ports: getesteter Code ruft nie die bare Global (Store-Linter
	// verlangt `window`, das es in node-env nicht gibt). Deshalb wird hier gegen ein
	// window-Stub geprüft — faellt das Delegieren beim Nachziehen weg, ist es sofort sichtbar.
	it('setTimeout/clearTimeout delegieren an window', () => {
		const calls: string[] = [];
		const stub = {
			setTimeout: (fn: () => void, ms: number) => { calls.push(`set:${ms}`); void fn; return 42; },
			clearTimeout: (id: number) => { calls.push(`clear:${id}`); },
		};
		const g = globalThis as unknown as { window?: unknown };
		const had = 'window' in g;
		const prev = g.window;
		g.window = stub;
		try {
			const id = realClock.setTimeout(() => undefined, 250);
			realClock.clearTimeout(id);
			expect(id).toBe(42);
			expect(calls).toEqual(['set:250', 'clear:42']);
		} finally {
			if (had) g.window = prev; else delete g.window;
		}
	});
});

describe('vendored endpoint_config', () => {
	it('migriert alte String-Listen und laesst Objekte stehen', () => {
		expect(migrateEndpointList(undefined, ['http://a', { url: 'http://b', apiKey: 'k' }]))
			.toEqual([{ url: 'http://a' }, { url: 'http://b', apiKey: 'k' }]);
	});

	it('authHeaders setzt Bearer nur bei gesetztem Schluessel', () => {
		expect(authHeaders('k')).toEqual({ Authorization: 'Bearer k' });
		expect(authHeaders(undefined)).toEqual({});
		expect(authHeaders('')).toEqual({});
	});

	// Falle (2) aus dem Kit-Rollout-Review: in der Adder-Zeile wird alles ausser der URL
	// STILL verworfen. Wer dort ein Schluesselfeld rendert, verliert die Eingabe beim Blur.
	it('applyEndpointEdit verwirft apiKey in der Adder-Zeile, nimmt dort aber die URL an', () => {
		const eps: EndpointConfig[] = [{ url: 'http://a' }];
		// Beide Zweige gegeneinander: die URL MUSS in der Adder-Zeile ankommen (sonst laesst
		// sich nichts hinzufuegen), der Schluessel darf es NICHT — sonst waere er beim Blur weg,
		// ohne dass es jemand merkt.
		expect(applyEndpointEdit(eps, 1, 'url', 'http://neu', true).map((e) => e.url))
			.toEqual(['http://a', 'http://neu']);
		expect(applyEndpointEdit(eps, 1, 'apiKey', 'geheim', true)).toEqual(eps);
		expect(applyEndpointEdit(eps, 0, 'apiKey', 'geheim', false))
			.toEqual([{ url: 'http://a', apiKey: 'geheim' }]);
	});

	it('moveEndpointToFront macht die Liste zur Prioritaet', () => {
		const eps: EndpointConfig[] = [{ url: 'http://a' }, { url: 'http://b' }];
		expect(moveEndpointToFront(eps, 1).map((e) => e.url)).toEqual(['http://b', 'http://a']);
	});

	it('carriesApiKey erkennt Drittanbieter-Zeilen', () => {
		expect(carriesApiKey({ url: 'http://a', apiKey: 'k' })).toBe(true);
		expect(carriesApiKey({ url: 'http://a' })).toBe(false);
	});

	it('endpointRole leitet sprachfrei ab', () => {
		expect(endpointRole({ isActive: true, reachable: true, modelFits: true, position: 1 }).kind).toBe('active');
		expect(endpointRole({ isActive: false, reachable: false, modelFits: true, position: 2 }).kind).toBe('unreachable');
	});

	// CHARAKTERISIERUNG, kein Wunschverhalten: das Kit faengt einen werfenden ping NICHT —
	// der Fehler reisst die ganze Fallback-Kette ab (Falle 4 des Kit-Rollout-Reviews, dort als
	// Consumer-Pflicht geführt). Deshalb muss LlmClient.ping intern fangen; das prueft
	// tests/core/orchestrator.test.ts. Faengt das Kit es eines Tages selbst, wird dieser Test
	// rot — und genau dann gehoert der Consumer-Guard ueberprueft.
	it('resolveActiveEndpointConfig reicht einen werfenden ping durch (Consumer muss fangen)', async () => {
		const eps: EndpointConfig[] = [{ url: 'http://tot' }, { url: 'http://lebt' }];
		await expect(resolveActiveEndpointConfig(eps, (cfg) => {
			if (cfg.url.includes('tot')) throw new Error('ECONNREFUSED');
			return Promise.resolve(true);
		})).rejects.toThrow('ECONNREFUSED');
	});

	it('resolveActiveEndpointConfig nimmt den ersten, dessen Probe true sagt', async () => {
		const eps: EndpointConfig[] = [{ url: 'http://tot' }, { url: 'http://lebt', apiKey: 'k' }];
		const active = await resolveActiveEndpointConfig(eps, (cfg) => Promise.resolve(cfg.url.includes('lebt')));
		expect(active?.url).toBe('http://lebt');
		// Der ganze Eintrag kommt zurueck, nicht nur die URL — daran haengt, dass der
		// Schluessel den aufgeloesten Endpunkt ueberhaupt erreicht.
		expect(active?.apiKey).toBe('k');
	});
});

describe('vendored model-choice + model-list-cache', () => {
	it('waehlt Dropdown bei Liste, Freitext ohne Liste, gesperrt wenn unerreichbar', () => {
		expect(resolveModelChoice({ reachable: true, models: ['a', 'b'], current: 'a' }).mode).toBe('dropdown');
		expect(resolveModelChoice({ reachable: true, models: [], current: 'x' }).mode).toBe('freetext');
		expect(resolveModelChoice({ reachable: false, models: [], current: 'x' }).mode).toBe('locked');
	});

	it('cached das Promise je Schluessel — ein Request pro Endpunkt', async () => {
		let calls = 0;
		const cache = createModelListCache();
		const client = {
			listModels: () => { calls += 1; return Promise.resolve(['m1']); },
			probe: () => Promise.resolve({ reachable: true }),
		};
		await Promise.all([cache.load('http://a', client), cache.load('http://a', client)]);
		expect(calls).toBe(1);
	});
});

describe('vendored endpoint_diagnostics extractModelIds', () => {
	it('zieht ids und wirft nie', () => {
		expect(extractModelIds({ data: [{ id: 'a' }, { id: 'b' }, {}] })).toEqual(['a', 'b']);
		expect(extractModelIds(null)).toEqual([]);
		expect(extractModelIds('<html>Fehlerseite</html>')).toEqual([]);
	});
});

describe('vendored timeout', () => {
	it('begrenzt die Wartezeit und reicht Fehler der Arbeit durch', async () => {
		const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
			clearTimeout: (id: number) => { clearTimeout(id); }, now: () => Date.now() };
		await expect(withTimeout(Promise.resolve('da'), 50, timers)).resolves.toEqual({ timedOut: false, value: 'da' });
		await expect(withTimeout(new Promise(() => undefined), 10, timers)).resolves.toEqual({ timedOut: true });
		await expect(withTimeout(Promise.reject(new Error('kaputt')), 50, timers)).rejects.toThrow('kaputt');
	});
});

describe('vendored capabilities', () => {
	// Der Punkt des Moduls: es behauptet nie mehr, als die Quelle hergibt.
	it('haelt Namens-Vermutung und bestaetigte Metadaten auseinander', () => {
		const guessed = guessFromName('qwen3-8b');
		expect(guessed.thinking.confidence).not.toBe('confirmed');
		const resolved = resolveCapabilities(null, 'irgendwas-unbekanntes', { thinking: true });
		expect(resolved.thinking.confidence).toBe('confirmed');
	});
});

describe('vendored error_body', () => {
	// Loeste am 2026-08-20 die repo-eigene Message-Extraktion aus src/core/chat-response.ts
	// ab (Kit-0.27.0-Vendoring). Die ersten drei
	// Kaskadenquellen kannte sie auch; `detail`, der Leerwert-Durchfall und der
	// choices-Waechter sind mit dem Vendoring dazugekommen.
	it('faehrt die Kaskade error.message -> error -> message -> detail', () => {
		expect(errorMessageFromBody({ error: { message: "model 'foo' not loaded" } })).toBe("model 'foo' not loaded");
		expect(errorMessageFromBody({ error: 'bad request' })).toBe('bad request');
		expect(errorMessageFromBody({ message: 'something failed' })).toBe('something failed');
		expect(errorMessageFromBody({ detail: 'Not authenticated' })).toBe('Not authenticated');
	});
	it('nimmt error.message vor error-als-String und message vor detail', () => {
		expect(errorMessageFromBody({ error: { message: 'genau' }, message: 'grob' })).toBe('genau');
		expect(errorMessageFromBody({ message: 'zuerst', detail: 'danach' })).toBe('zuerst');
	});
	it('laesst Leerwerte durchfallen und trimmt jeden Treffer', () => {
		expect(errorMessageFromBody({ error: '', message: 'model not found' })).toBe('model not found');
		expect(errorMessageFromBody({ error: { message: '   ' }, detail: '  spaet  ' })).toBe('spaet');
		expect(errorMessageFromBody({ error: '', message: '', detail: '' })).toBeNull();
	});
	it('null bei Nicht-Objekt, Array, null und unbekannten Feldern', () => {
		expect(errorMessageFromBody('plain text')).toBeNull();
		expect(errorMessageFromBody(null)).toBeNull();
		expect(errorMessageFromBody([])).toBeNull();
		expect(errorMessageFromBody({ foo: 'bar' })).toBeNull();
	});
	it('bodyMayBeSuccess blendet message/detail neben choices aus — error aber nicht', () => {
		// Dieses Repo nutzt den Waechter an keiner Aufrufstelle (beide kommen ueber einen
		// Fehlerpfad); der Vertrag gehoert trotzdem in die Kopie.
		expect(errorMessageFromBody({ choices: [], detail: 'stray' }, { bodyMayBeSuccess: true })).toBeNull();
		expect(errorMessageFromBody({ choices: [], message: 'stray' }, { bodyMayBeSuccess: true })).toBeNull();
		expect(errorMessageFromBody({ choices: [], error: { message: 'HTTP-200-Fehler' } }, { bodyMayBeSuccess: true }))
			.toBe('HTTP-200-Fehler');
		expect(errorMessageFromBody({ choices: [], detail: 'stray' })).toBe('stray');
	});
	it('errorMessageFromText parst selbst und gibt bei kaputtem JSON null', () => {
		expect(errorMessageFromText('{"error":"bad request"}')).toBe('bad request');
		expect(errorMessageFromText('<html>502</html>')).toBeNull();
		expect(errorMessageFromText('')).toBeNull();
		expect(errorMessageFromText('   ')).toBeNull();
		expect(errorMessageFromText('123')).toBeNull();
		expect(errorMessageFromText('[]')).toBeNull();
	});
});

describe('vendored frontmatter (obsidian-kit 0.97.0)', () => {
	it('serializeFrontmatter schreibt Schluessel in der angegebenen Reihenfolge', () => {
		const out = serializeFrontmatter({ type: 'x' }, ['type']);
		expect(out).toContain('type: x');
		expect(out.startsWith('---\n')).toBe(true);
	});
	it('parseFrontmatter liest den Block und trennt den Rumpf ab', () => {
		const fm = parseFrontmatter('---\ntype: x\ntags:\n  - a\n---\nText\n');
		expect(fm.data.type).toBe('x');
		expect(fm.data.tags).toEqual(['a']);
		expect(fm.body).toBe('Text\n');
	});
	it('wikilinkOf: Pfadlink ohne .md, null bei Zeichen, die sich nicht schreiben lassen', () => {
		expect(wikilinkOf('00_Inbox/t.md')).toBe('[[00_Inbox/t]]');
		expect(wikilinkOf('bild.png')).toBe('[[bild.png]]');
		expect(wikilinkOf('00_Inbox/t.md', { alias: true })).toBe('[[00_Inbox/t|t]]');
		expect(wikilinkOf('Was #1.md')).toBeNull();
		expect(wikilinkOf('a|b.md')).toBeNull();
		expect(wikilinkOf('')).toBeNull();
		expect(wikilinkOf('A/')).toBeNull();
	});
	it('wikilinkDisplayText ist das Gegenstueck (letztes Segment ohne Anker)', () => {
		expect(wikilinkDisplayText('[[00_Inbox/t]]')).toBe('t');
		expect(wikilinkDisplayText('[[00_Inbox/t|Titel]]')).toBe('Titel');
		expect(wikilinkDisplayText('Klartext')).toBe('Klartext');
	});
});

describe('vendored rel-path baseName und error-message', () => {
	it('baseName ist das letzte Segment', () => {
		expect(baseName('A/B/Notiz')).toBe('Notiz');
		expect(baseName('Notiz')).toBe('Notiz');
		expect(baseName('A/')).toBe('');
	});
	it('errorMessage nimmt message eines Error, sonst den Text', () => {
		expect(errorMessage(new Error('kaputt'))).toBe('kaputt');
		expect(errorMessage('roh')).toBe('roh');
	});
});

describe('vendored endpoint-source: der tatsaechlich benutzte Endpunkt (Welle 34, Paket 9)', () => {
	// Zwei Endpunkte beim Manager, der erste unerreichbar: `resolve` ueberspringt ihn und liefert den zweiten.
	const entry = (id: string): ApiEndpoint => ({ id, label: id, provider: 'openai' } as unknown as ApiEndpoint);
	function manager(over: Partial<LlmEndpointManagerApi> = {}): LlmEndpointManagerApi {
		const resolved = (id: string): ResolvedEndpoint => ({
			id, config: { id, name: id, url: `http://${id}.test/v1`, enabled: true } as unknown as ResolvedEndpoint['config'], defaultModel: `${id}-modell`,
		} as unknown as ResolvedEndpoint);
		return {
			version: 1, list: () => [entry('a'), entry('b')], get: () => null,
			resolve: async () => resolved('b'),
			materialize: async (id) => (id === 'a' ? { error: 'unreachable' } : resolved(id)),
			models: async () => [], importEndpoints: async () => ({ added: [], merged: [], skipped: [] }), on: () => () => {}, ...over,
		};
	}
	it('Automatisch: endpointId ist der zweite, erreichbare, nicht der erste Eintrag der Liste', async () => {
		const r = await resolveEndpointSource({ manager: manager(), local: [], capability: 'chat', caller: 'vault-crews' }, () => Promise.resolve(true));
		expect(r.kind).toBe('manager');
		expect(r.endpointId).toBe('b');
		expect(r.model).toBe('b-modell');
	});
	it('verwaiste Wahl auf den unerreichbaren ersten: automatisch weiter, Grund mitgeteilt, Modell des zweiten', async () => {
		const r = await resolveEndpointSource(
			{ manager: manager(), local: [], capability: 'chat', choice: { endpointId: 'a', model: 'fremd' }, caller: 'vault-crews' },
			() => Promise.resolve(true),
		);
		expect(r.endpointId).toBe('b');
		expect(r.reason).toBe('unreachable');
		expect(r.model).toBe('b-modell');
	});
	it('lokal und ohne Config fehlt endpointId: unbekannt bleibt unbekannt', async () => {
		const r = await resolveEndpointSource({ manager: null, local: [], capability: 'chat' }, () => Promise.resolve(true));
		expect(r.endpointId).toBeUndefined();
	});
});

describe('vendored gzip-text (code-kit 0.77.0, Mitschnitt calls.jsonl.gz)', () => {
	it('Rundreise Byte fuer Byte: U+2011, U+202F, Emoji, CRLF, leerer Text', async () => {
		for (const text of ['a\u2011b c\u202Fd', '\u{1F600} \r\n x', '']) {
			expect(await gunzipText(await gzipText(text))).toBe(text);
		}
	});
	it('gunzipText verweigert, was kein vollstaendiger gzip-Strom ist', async () => {
		const bytes = await gzipText('abc');
		await expect(gunzipText(bytes.slice(0, bytes.length - 3))).rejects.toThrow();
	});
});

describe('vendored recording-transport (obsidian-kit 0.97.0)', () => {
	it('ruft sink genau einmal, reicht Chunks und Status durch, der Datensatz traegt keine Kopfzeilen', async () => {
		const inner: SseTransport = {
			postStream: async (_url, _body, _headers, onChunk) => { onChunk('data: a\n'); onChunk('data: [DONE]\n'); return 200; },
		};
		const seen: TransportExchange[] = [];
		const chunks: string[] = [];
		const body = { stream: true };
		const status = await recordingTransport(inner, (x) => { seen.push(x); }, () => 5)
			.postStream('http://x.test/v1', body, { Authorization: 'Bearer geheim' }, (c) => chunks.push(c), new AbortController().signal);
		expect(status).toBe(200);
		expect(chunks).toEqual(['data: a\n', 'data: [DONE]\n']);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ url: 'http://x.test/v1', status: 200, raw: 'data: a\ndata: [DONE]\n', startedAt: 5, endedAt: 5 });
		expect(seen[0]?.body).toBe(body);
		expect(JSON.stringify(seen[0])).not.toContain('geheim');
		expect(Object.keys(seen[0] ?? {})).not.toContain('headers');
	});
	it('Ablehnung: dasselbe Fehlerobjekt geht weiter, sink einmal mit status null und error', async () => {
		const boom = Object.assign(new Error('weg'), { name: 'AbortError' });
		const inner: SseTransport = { postStream: async (_u, _b, _h, onChunk) => { onChunk('teil'); throw boom; } };
		const seen: TransportExchange[] = [];
		await expect(recordingTransport(inner, (x) => { seen.push(x); })
			.postStream('u', {}, {}, () => {}, new AbortController().signal)).rejects.toBe(boom);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ status: null, raw: 'teil', error: 'AbortError: weg' });
	});
});
