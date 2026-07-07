# Provider-agnostische lokale LLM-Anbindung (Ollama-Support) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vault-crews spricht neben LM Studio auch Ollama, ohne Provider-Setting — der Client sondiert native Metadaten-Endpunkte und fällt bei CORS auf Non-Streaming zurück.

**Architecture:** Ein neuer pure-Layer (`model-info.ts`) kapselt Provider-Unterschiede als reine Funktionen; der bestehende Client (umbenannt `LocalLlmClient`) nutzt sie für eine Doppel-Sonde (LM Studio `/api/v0/models` → Ollama `/api/show`), eine Union-Thinking-Suppression und einen CORS-Non-Stream-Fallback. Always-on-Thinker werden erkannt und via run.md + Notice gemeldet.

**Tech Stack:** TypeScript, Obsidian-Plugin, Vitest (node-env, Obsidian-Mock via `resolve.alias`), esbuild.

## Global Constraints

- **Gate (vor jedem Commit grün):** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen, nicht grep.
- **Purität:** `src/core/**` importiert NIE `obsidian` (CI-Gate `check:pure`). `model-info.ts` und die Client-Änderungen bleiben obsidian-frei; nur `transports.ts`/`main.ts` (in `src/obsidian/` bzw. Wiring) dürfen Obsidian sehen.
- **Ports injiziert:** Client kennt nur `SseTransport`/`JsonTransport`/`ClockPort` (ports.ts), nie XHR/`requestUrl` direkt.
- **Indentierung:** `src/core/**` + `tests/**` nutzen Tabs (bestehende Dateien matchen).
- **Commit style:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Kein `json_schema`-API-Modus, kein Provider-Enum, kein neues Setting** (Spec Nicht-Ziel).
- **Ollama-Gotcha:** `reasoning_effort` nie als Boolean / nie `"minimal"` (Ollama lehnt beides ab) — immer der String `"none"`.

---

### Task 1: Pure-Layer `model-info.ts`

**Files:**
- Create: `src/core/model-info.ts`
- Test: `tests/core/model-info.test.ts`

**Interfaces:**
- Consumes: nichts (reiner Layer).
- Produces:
  - `interface ModelContext { maxContextLength?: number; loadedContextLength?: number }`
  - `parseLmStudioContext(json: unknown, model: string): ModelContext | null`
  - `parseOllamaContext(json: unknown): ModelContext | null`
  - `suppressParams(suppress: boolean): Record<string, unknown>`
  - `isAlwaysOnThinker(model: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/model-info.test.ts
import { describe, expect, it } from 'vitest';
import {
	parseLmStudioContext, parseOllamaContext, suppressParams, isAlwaysOnThinker,
} from '../../src/core/model-info';

describe('parseLmStudioContext', () => {
	const json = { data: [
		{ id: 'qwen3-8b', max_context_length: 32768, loaded_context_length: 8192 },
		{ id: 'other', max_context_length: 4096 },
	] };
	it('liest loaded + max für das getroffene Modell', () => {
		expect(parseLmStudioContext(json, 'qwen3-8b')).toEqual({ maxContextLength: 32768, loadedContextLength: 8192 });
	});
	it('gibt null bei fehlendem Modell', () => {
		expect(parseLmStudioContext(json, 'missing')).toBeNull();
	});
	it('gibt null bei nicht-Array data', () => {
		expect(parseLmStudioContext({ data: 'x' }, 'a')).toBeNull();
	});
});

describe('parseOllamaContext', () => {
	it('liest <arch>.context_length aus model_info', () => {
		expect(parseOllamaContext({ model_info: { 'qwen3.context_length': 40960, 'general.name': 'q' } }))
			.toEqual({ maxContextLength: 40960 });
	});
	it('gibt null wenn kein *.context_length vorhanden', () => {
		expect(parseOllamaContext({ model_info: { 'general.name': 'q' } })).toBeNull();
	});
	it('gibt null bei fehlendem model_info', () => {
		expect(parseOllamaContext({})).toBeNull();
	});
});

describe('suppressParams', () => {
	it('leeres Objekt wenn nicht unterdrückt', () => {
		expect(suppressParams(false)).toEqual({});
	});
	it('Union-Params (reasoning_effort String "none", nie Boolean)', () => {
		expect(suppressParams(true)).toEqual({
			reasoning_effort: 'none',
			chat_template_kwargs: { enable_thinking: false },
			reasoning_budget: 0,
		});
	});
});

describe('isAlwaysOnThinker', () => {
	it('erkennt gpt-oss und harmony', () => {
		expect(isAlwaysOnThinker('gpt-oss-20b')).toBe(true);
		expect(isAlwaysOnThinker('some-harmony-model')).toBe(true);
	});
	it('false für generische Modelle', () => {
		expect(isAlwaysOnThinker('qwen3-8b')).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/model-info.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/model-info'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/model-info.ts
/** Provider-agnostische Metadaten-Parser + Reasoning-Steuerung (pure, obsidian-frei).
 *  Portiert aus markdown-presentation/src/core/llm/{model-info,reasoning}.ts (Kit-Muster). */

export interface ModelContext { maxContextLength?: number; loadedContextLength?: number }

function findById(json: unknown, model: string): Record<string, unknown> | null {
	const data = (json as { data?: unknown }).data;
	if (!Array.isArray(data)) return null;
	const hit = (data as unknown[]).find((x) => (x as { id?: unknown }).id === model);
	return (hit as Record<string, unknown> | undefined) ?? null;
}

/** LM Studio GET /api/v0/models → per-Modell-Kontextlängen. null wenn Modell fehlt. */
export function parseLmStudioContext(json: unknown, model: string): ModelContext | null {
	const m = findById(json, model);
	if (!m) return null;
	const out: ModelContext = {};
	if (typeof m.max_context_length === 'number') out.maxContextLength = m.max_context_length;
	if (typeof m.loaded_context_length === 'number') out.loadedContextLength = m.loaded_context_length;
	return out;
}

/** Ollama POST /api/show → model_info hält "<arch>.context_length". null wenn nicht vorhanden. */
export function parseOllamaContext(json: unknown): ModelContext | null {
	const info = (json as { model_info?: unknown }).model_info;
	if (!info || typeof info !== 'object') return null;
	for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
		if (k.endsWith('.context_length') && typeof v === 'number') return { maxContextLength: v };
	}
	return null;
}

/** Union-Params zum Abschalten von Reasoning über viele lokale Server hinweg.
 *  reasoning_effort:"none" (Ollama/vLLM/OpenAI) + chat_template_kwargs (llama.cpp/MLX/LM Studio/Qwen3)
 *  + reasoning_budget:0 (llama.cpp). WICHTIG: reasoning_effort nie Boolean / nie "minimal". */
export function suppressParams(suppress: boolean): Record<string, unknown> {
	if (!suppress) return {};
	return {
		reasoning_effort: 'none',
		chat_template_kwargs: { enable_thinking: false },
		reasoning_budget: 0,
	};
}

const ALWAYS_ON = /\b(gpt-oss|harmony)\b/i;

/** Modelle mit fest verdrahtetem Reasoning (nur low/medium/high, kein vollständiges Off). */
export function isAlwaysOnThinker(model: string): boolean {
	return ALWAYS_ON.test(model);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/model-info.test.ts`
Expected: PASS (11 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/model-info.ts tests/core/model-info.test.ts
git commit -m "feat(llm): pure model-info Layer (LM Studio + Ollama Parser, suppressParams, always-on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rename `LmStudioClient` → `LocalLlmClient`

Reiner Rename (kein Verhalten), damit der Name nach der Provider-Öffnung ehrlich ist.

**Files:**
- Rename: `src/core/lmstudio-client.ts` → `src/core/local-llm-client.ts` (Klasse `LmStudioClient` → `LocalLlmClient`)
- Rename: `tests/core/lmstudio-client.test.ts` → `tests/core/local-llm-client.test.ts` (Import + `describe`-Namen anpassen)
- Modify: `src/main.ts:44` (Import), `src/main.ts:191` (`new LmStudioClient` → `new LocalLlmClient`)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `class LocalLlmClient implements LlmClient` (gleiche Konstruktor-Signatur + Methoden wie bisher).

- [ ] **Step 1: git-mv beider Dateien**

```bash
git mv src/core/lmstudio-client.ts src/core/local-llm-client.ts
git mv tests/core/lmstudio-client.test.ts tests/core/local-llm-client.test.ts
```

- [ ] **Step 2: Klasse + Testimporte umbenennen**

In `src/core/local-llm-client.ts`: `export class LmStudioClient` → `export class LocalLlmClient`.
In `tests/core/local-llm-client.test.ts`:
- Import-Zeile: `import { LmStudioClient } from '../../src/core/lmstudio-client';` → `import { LocalLlmClient } from '../../src/core/local-llm-client';`
- Alle `LmStudioClient` im Testkörper (Rückgabetyp in `make()`, `new LmStudioClient(...)`) → `LocalLlmClient`.
- `describe('LmStudioClient.stream', …)` → `describe('LocalLlmClient.stream', …)` (und weitere describe-Blöcke analog).

In `src/main.ts`:
- Zeile 44: `import { LmStudioClient } from "./core/lmstudio-client";` → `import { LocalLlmClient } from "./core/local-llm-client";`
- Zeile 191: `return new LmStudioClient(` → `return new LocalLlmClient(`

- [ ] **Step 3: Restliche Referenzen prüfen**

Run: `rg -n "LmStudioClient|lmstudio-client" src tests`
Expected: keine Treffer.

- [ ] **Step 4: Gate**

Run: `npm run gate`
Expected: PASS (Exit 0), 252 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(llm): LmStudioClient -> LocalLlmClient (provider-agnostischer Name)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `modelInfo()` Doppel-Sonde (LM Studio → Ollama)

**Files:**
- Modify: `src/core/local-llm-client.ts` (`modelInfo`, ~Zeilen 55–71 der Alt-Datei)
- Test: `tests/core/local-llm-client.test.ts` (neuer describe-Block `modelInfo`)

**Interfaces:**
- Consumes: `parseLmStudioContext`, `parseOllamaContext`, `ModelContext` (Task 1); `JsonTransport.getJson/postJson` (ports.ts).
- Produces: unveränderte Signatur `modelInfo(model: string): Promise<ModelInfo | null>` (ModelInfo aus ports.ts, `{ id, contextLength }`).

- [ ] **Step 1: Write the failing test**

Am Ende von `tests/core/local-llm-client.test.ts` ergänzen. `FakeJson.postJson` protokolliert URL + Body (der bestehende Stub gibt nur `{}` zurück — hier erweitern):

```ts
// FakeJson erweitern: postJson konfigurierbar machen
// (ersetze die bestehende FakeJson.postJson-Zeile durch eine, die aus responses liest
//  und die letzte Anfrage merkt):
//
//   lastPostUrl = '';
//   lastPostBody: unknown = null;
//   async postJson(url: string, body: unknown): Promise<unknown> {
//     this.lastPostUrl = url; this.lastPostBody = body;
//     if (!this.responses.has(url)) return {};
//     return this.responses.get(url);
//   }

describe('LocalLlmClient.modelInfo', () => {
	it('nimmt LM Studios loaded_context_length wenn /api/v0/models trifft', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', {
			data: [{ id: 'qwen3-8b', max_context_length: 32768, loaded_context_length: 8192 }],
		});
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: 8192 });
	});

	it('fällt auf Ollama /api/show zurück wenn LM Studio nichts liefert', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', { data: [] });
		json.responses.set('http://localhost:1234/api/show', { model_info: { 'qwen3.context_length': 40960 } });
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: 40960 });
		expect(json.lastPostUrl).toBe('http://localhost:1234/api/show');
		expect(json.lastPostBody).toEqual({ model: 'qwen3-8b' });
	});

	it('gibt {contextLength:null} wenn keine Sonde greift', async () => {
		const { client, json } = make();
		json.responses.set('http://localhost:1234/api/v0/models', { data: [] });
		json.responses.set('http://localhost:1234/api/show', {});
		expect(await client.modelInfo('qwen3-8b')).toEqual({ id: 'qwen3-8b', contextLength: null });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t modelInfo`
Expected: FAIL — Ollama-Fallback wird nicht abgefragt (aktuell nur `/api/v0/models`).

- [ ] **Step 3: Write minimal implementation**

In `src/core/local-llm-client.ts` den Import ergänzen und `modelInfo` ersetzen:

```ts
import { parseLmStudioContext, parseOllamaContext } from './model-info';
// (bestehende Imports beibehalten)
```

```ts
	/** Best-effort Kontextlänge: erst LM Studios /api/v0/models, dann Ollamas
	 *  POST /api/show. Wer antwortet, gewinnt; sonst contextLength = null. */
	async modelInfo(model: string): Promise<ModelInfo | null> {
		try {
			const lm = await this.json.getJson(`${this.base}/api/v0/models`);
			const ctx = parseLmStudioContext(lm, model);
			if (ctx) return { id: model, contextLength: ctx.loadedContextLength ?? ctx.maxContextLength ?? null };
		} catch { /* nächste Sonde */ }
		try {
			const oll = await this.json.postJson(`${this.base}/api/show`, { model });
			const ctx = parseOllamaContext(oll);
			if (ctx) return { id: model, contextLength: ctx.maxContextLength ?? null };
		} catch { /* aufgeben */ }
		return { id: model, contextLength: null };
	}
```

Hinweis: Rückgabe ist jetzt immer non-null (`{ id, contextLength: null }` statt früher `null`). Der einzige Konsument (`orchestrator.ts:151` `info?.contextLength ?? null`) verträgt beides — kein Anpassungsbedarf.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS (modelInfo-Block + bestehende Stream-Tests grün).

- [ ] **Step 5: Commit**

```bash
git add src/core/local-llm-client.ts tests/core/local-llm-client.test.ts
git commit -m "feat(llm): modelInfo Doppel-Sonde (LM Studio /api/v0/models -> Ollama /api/show)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Union-Thinking-Suppression über `suppressParams`

**Files:**
- Modify: `src/core/local-llm-client.ts` (`stream`, Body-Aufbau ~Zeilen 79–89 der Alt-Datei)
- Test: `tests/core/local-llm-client.test.ts` (Erweiterung eines bestehenden thinking-Tests)

**Interfaces:**
- Consumes: `suppressParams` (Task 1).
- Produces: keine Signaturänderung.

- [ ] **Step 1: Write the failing test**

```ts
describe('LocalLlmClient thinking-Suppression', () => {
	it('sendet reasoning_effort "none" + enable_thinking:false + reasoning_budget:0 bei thinking:off', async () => {
		const { client, sse, clock } = make();
		const params: LlmParams = { model: 'm', temperature: 0.1, maxTokens: 128, thinking: 'off' };
		const p = client.stream([{ role: 'user', content: 'q' }], params, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody.reasoning_effort).toBe('none');
		expect(sse.lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(sse.lastBody.reasoning_budget).toBe(0);
	});

	it('sendet keine Suppress-Felder bei thinking:auto', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		await p;
		expect(sse.lastBody.reasoning_effort).toBeUndefined();
		expect(sse.lastBody.reasoning_budget).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "thinking-Suppression"`
Expected: FAIL — `reasoning_budget` fehlt heute (nur reasoning_effort + chat_template_kwargs).

- [ ] **Step 3: Write minimal implementation**

In `src/core/local-llm-client.ts` den Import ergänzen:

```ts
import { parseLmStudioContext, parseOllamaContext, suppressParams } from './model-info';
```

Body-Aufbau in `stream()` ersetzen — den `if (params.thinking === 'off') { … }`-Block streichen und durch ein Spread ersetzen:

```ts
		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			stream: true,
			...suppressParams(params.thinking === 'off'),
		};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/local-llm-client.ts tests/core/local-llm-client.test.ts
git commit -m "feat(llm): Union-Thinking-Suppression (reasoning_budget:0 ergaenzt, via suppressParams)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: CORS-Non-Stream-Fallback

Ollama blockt Streaming aus Obsidian (kein `OLLAMA_ORIGINS`): Ping ok, Stream refused. Der Client fällt einmal auf einen Non-Streaming-Call (CORS-frei via `requestUrl`/`postJson`) zurück und merkt sich das für den restlichen Lauf.

**Files:**
- Modify: `src/obsidian/transports.ts` (`XhrSseTransport.postStream`, `xhr.onerror`)
- Modify: `src/core/local-llm-client.ts` (`stream`: `streamRefused`-Feld + Fallback-Pfad + private `streamNonStreaming`)
- Test: `tests/core/local-llm-client.test.ts` (neuer describe-Block `CORS-Fallback`)

**Interfaces:**
- Consumes: `JsonTransport.postJson` (ports.ts), `suppressParams` (Task 1), lokale `thinkTokens`-Helferfunktion (bereits in der Datei).
- Produces: keine Signaturänderung; neues Verhalten bei `SseTransport`-Reject mit `name === 'StreamNetworkError'`.

- [ ] **Step 1: Write the failing test**

Der `FakeSse` braucht einen Weg, einen Netzwerk-Refusal zu simulieren. Ergänze in `FakeSse` eine Methode:

```ts
	// in FakeSse:
	fail(name = 'StreamNetworkError'): void {
		const e = new Error('refused'); e.name = name;
		// reject des offenen postStream-Promise:
		this.reject?.(e);
	}
	// und im postStream-Promise zusätzlich this.reject speichern:
	//   return new Promise((res, rej) => { this.resolve = res; this.reject = rej; });
	// Feld deklarieren: private reject: ((e: Error) => void) | null = null;
```

```ts
describe('LocalLlmClient CORS-Fallback', () => {
	it('fällt bei StreamNetworkError auf Non-Streaming (postJson) zurück', async () => {
		const { client, sse, json } = make();
		json.responses.set('http://localhost:1234/v1/chat/completions', {
			choices: [{ message: { content: 'Hallo aus Fallback' }, finish_reason: 'stop' }],
		});
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('StreamNetworkError');
		const r = await p;
		expect(r.content).toBe('Hallo aus Fallback');
		expect(r.finishReason).toBe('stop');
		expect(json.lastPostUrl).toBe('http://localhost:1234/v1/chat/completions');
		expect((json.lastPostBody as { stream?: boolean }).stream).toBe(false);
	});

	it('propagiert AbortError statt zurückzufallen', async () => {
		const { client, sse } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('AbortError');
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('erkennt Context-Overflow im Fallback-Body', async () => {
		const { client, sse, json } = make();
		json.responses.set('http://localhost:1234/v1/chat/completions', {
			error: { message: 'context length exceeded' },
		});
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await Promise.resolve();
		sse.fail('StreamNetworkError');
		await expect(p).rejects.toMatchObject({ kind: 'overflow' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "CORS-Fallback"`
Expected: FAIL — heutiger `stream()` fängt den Reject nicht ab, das Promise rejectet mit `refused`.

- [ ] **Step 3a: Transport-Vertrag schärfen**

In `src/obsidian/transports.ts` die `xhr.onerror`-Zeile ersetzen:

```ts
      xhr.onerror = (): void => {
        const e = new Error(`vault-crews: Netzwerkfehler POST ${url}`);
        e.name = "StreamNetworkError";
        reject(e);
      };
```

- [ ] **Step 3b: Client-Fallback implementieren**

In `src/core/local-llm-client.ts`:

Feld ergänzen (bei den anderen privaten Feldern):

```ts
	private streamRefused = false;
```

Am Anfang von `stream()` (vor dem Body-Aufbau) den Shortcut setzen:

```ts
		if (this.streamRefused) return this.streamNonStreaming(messages, params, signal);
```

Den `postStream`-`try { … } finally { … }`-Block zu `try { … } catch { … } finally { … }` erweitern: den geworfenen Fehler zwischenspeichern, im `finally` wie bisher Timer räumen, und NACH dem Block auswerten. Konkret die bestehende Struktur so umbauen:

```ts
		let status: number;
		let streamError: unknown = null;
		try {
			status = await this.sse.postStream(
				`${this.base}/v1/chat/completions`,
				body,
				(raw) => { /* unveränderter onChunk-Rumpf */ },
				ctrl.signal,
			);
		} catch (e) {
			streamError = e;
			status = 0;
		} finally {
			this.clock.clearTimeout(hardTimer);
			if (stallTimer !== null) this.clock.clearTimeout(stallTimer);
			signal.removeEventListener('abort', onCallerAbort);
		}

		if (streamError !== null) {
			const name = (streamError as { name?: string }).name;
			if (name === 'AbortError') throw streamError;
			if (name === 'StreamNetworkError') {
				this.streamRefused = true;
				return this.streamNonStreaming(messages, params, signal);
			}
			throw streamError; // unerwarteter Fehler — nicht schlucken
		}
```

Der restliche `stream()`-Rumpf (Tail-Flush, abortKind-Auswertung, Status-Check) bleibt unverändert.

Neue private Methode am Ende der Klasse (nutzt `suppressParams` + lokale `thinkTokens`):

```ts
	/** Non-Streaming-Fallback (CORS-frei via JsonTransport.postJson). Overflow wird aus
	 *  dem Body-Text gesnifft — der HTTP-Status ist über postJson nicht sichtbar, wird
	 *  hier aber (wie im Streaming-Pfad) auch nicht gebraucht. */
	private async streamNonStreaming(
		messages: LlmMessage[],
		params: LlmParams,
		signal: AbortSignal,
	): Promise<LlmStreamResult> {
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			stream: false,
			...suppressParams(params.thinking === 'off'),
		};
		const res = await this.json.postJson(`${this.base}/v1/chat/completions`, body);
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const rawBody = JSON.stringify(res ?? {});
		if (/context (length|window)|too many tokens/i.test(rawBody)) {
			throw new LlmCallError('Kontextfenster überschritten (Non-Streaming)', 'overflow');
		}
		const choice = isRecord(res) && Array.isArray(res.choices) ? res.choices[0] : null;
		const msg = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
		const content = msg && typeof msg.content === 'string' ? msg.content : null;
		if (content === null) {
			throw new LlmCallError(`Non-Streaming-Antwort ohne content: ${rawBody.slice(0, 300)}`, 'http');
		}
		const reasoning = msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
		return { content, thinkTokens: thinkTokens(reasoning), finishReason: 'stop' };
	}
```

Sicherstellen, dass `isRecord` (bereits am Dateiende definiert) und `thinkTokens` in Scope sind — beide existieren schon in der Datei.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS (CORS-Fallback-Block + alle bestehenden Tests).

- [ ] **Step 5: Gate + Commit**

Run: `npm run gate`
Expected: PASS (Exit 0).

```bash
git add src/obsidian/transports.ts src/core/local-llm-client.ts tests/core/local-llm-client.test.ts
git commit -m "feat(llm): CORS-Non-Stream-Fallback (StreamNetworkError -> postJson stream:false)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Always-on-Thinker-Erkennung (run.md + Notice)

**Files:**
- Modify: `src/core/types.ts` (`RunState` + `RunResult`: Feld `alwaysOnThinker: boolean`)
- Modify: `src/core/orchestrator.ts` (State-Init `:72`, Detektion in `checkEndpointAndModel` `:148-152`, `result()` `:378`, `finishRefused` `:356`)
- Modify: `src/core/run-log.ts` (`frontmatterLines`: Zeile `always_on_thinker: true`)
- Modify: `src/main.ts` (`onRunFinished`/`showRunNotice`: Zusatz-Notice bei `result.alwaysOnThinker`)
- Modify: `src/i18n/strings.ts` (Key `notice.run.alwaysOnThinker`, en + de)
- Test: `tests/core/run-log.test.ts` (Frontmatter-Zeile), plus Orchestrator-Test falls vorhanden

**Interfaces:**
- Consumes: `isAlwaysOnThinker` (Task 1).
- Produces: `RunState.alwaysOnThinker: boolean`, `RunResult.alwaysOnThinker: boolean`.

- [ ] **Step 1: Write the failing test (run-log)**

In `tests/core/run-log.test.ts` (Muster der bestehenden buildRunMd-Tests folgen — einen State bauen, der `alwaysOnThinker: true` setzt, und prüfen):

```ts
it('schreibt always_on_thinker:true in die Frontmatter wenn gesetzt', () => {
	const state = makeState({ alwaysOnThinker: true }); // Helper der Testdatei; sonst inline State-Literal
	expect(buildRunMd(state)).toContain('always_on_thinker: true');
});
it('lässt always_on_thinker weg wenn false', () => {
	const state = makeState({ alwaysOnThinker: false });
	expect(buildRunMd(state)).not.toContain('always_on_thinker');
});
```

> Falls `tests/core/run-log.test.ts` keinen `makeState`-Helper hat: das bestehende State-Literal der Datei kopieren und `alwaysOnThinker` ergänzen (alle State-Literale brauchen das neue Pflichtfeld — der Typecheck erzwingt es).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/run-log.test.ts`
Expected: FAIL — Typecheck/Feld fehlt bzw. Zeile wird nicht geschrieben.

- [ ] **Step 3: Typen + Detektion + Rendering + Notice**

`src/core/types.ts` — beide Interfaces ergänzen:

```ts
// in RunState (nach contextLength):
	alwaysOnThinker: boolean;
// in RunResult (nach errorKind):
	alwaysOnThinker: boolean;
```

`src/core/orchestrator.ts`:
- Import ergänzen: `import { isAlwaysOnThinker } from './model-info';`
- State-Init (`:72`, im `this.state = { … }`-Literal) `alwaysOnThinker: false,` ergänzen.
- In `checkEndpointAndModel`, innerhalb der `for (const model of this.effectiveModels())`-Schleife (`:148`), nach dem `modelInfo`-Call:

```ts
			if (isAlwaysOnThinker(model)) this.state.alwaysOnThinker = true;
```

- In `result()` (`:378`) ergänzen: `alwaysOnThinker: this.state.alwaysOnThinker,`
- In `finishRefused()` (`:356`, RunResult-Literal) ebenfalls `alwaysOnThinker: this.state.alwaysOnThinker,` ergänzen (State ist da schon initialisiert → `false`, außer Refusal käme nach der Detektion; korrekt in beiden Fällen).

`src/core/run-log.ts` — in `frontmatterLines`, vor dem `error_task`-Block:

```ts
	if (state.alwaysOnThinker) lines.push('always_on_thinker: true');
```

`src/i18n/strings.ts` — in beiden Locale-Blöcken einen Key ergänzen (englischer + deutscher Block, Muster `notice.run.*`):

```ts
// en:
	"notice.run.alwaysOnThinker": "This model keeps reasoning by design (gpt-oss/harmony) — 'thinking: off' does not fully apply.",
// de:
	"notice.run.alwaysOnThinker": "Dieses Modell denkt prinzipbedingt weiter (gpt-oss/harmony) — 'thinking: off' greift nicht vollständig.",
```

`src/main.ts` — in `onRunFinished` (`:321`) nach `this.showRunNotice(...)`:

```ts
    if (result.alwaysOnThinker) new Notice(t("notice.run.alwaysOnThinker"));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/run-log.test.ts`
Expected: PASS.

Run: `npm run gate`
Expected: PASS (Exit 0) — der Typecheck erzwingt, dass alle RunState/RunResult-Literale in Tests + Code das neue Feld haben; fehlende Stellen hier nachziehen (Fixtures/Helper in `tests/`).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/orchestrator.ts src/core/run-log.ts src/main.ts src/i18n/strings.ts tests/
git commit -m "feat(llm): Always-on-Thinker erkennen (run.md-Vermerk + Notice)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Doku — Smoke-Checkliste + README-Providernotiz

**Files:**
- Modify: `AGENTS.md` (§ „Architecture notes" LM-Studio-Zeile + § „Smoke checklist")
- Modify: `README.md` (Endpoint-/Provider-Abschnitt: Ollama nennen)
- Modify: `CHANGELOG.md` (Unreleased-Abschnitt — **nicht** dated, Release-Script fügt die dated Überschrift später ein; Handoff-Gotcha)

**Interfaces:** keine (nur Doku).

- [ ] **Step 1: AGENTS.md aktualisieren**

- Die „LM Studio:"-Architektur-Notiz (~Zeile 40) um Ollama ergänzen: Kontextlänge kommt aus `/api/v0/models` (LM Studio) **oder** `POST /api/show` (Ollama, `model_info["<arch>.context_length"]`); Thinking-Suppression ist provider-übergreifend (`suppressParams`); bei Ollama ggf. `OLLAMA_ORIGINS` für Streaming, sonst greift der Non-Stream-Fallback.
- Smoke-Checkliste: einen Schritt „(optional) gegen laufendes Ollama (`http://localhost:11434/v1`): Endpoint eintragen, eine Crew laufen lassen; ohne `OLLAMA_ORIGINS` erscheint kein Live-Token-Ticker (Non-Stream-Fallback), Ergebnis kommt trotzdem" ergänzen.

- [ ] **Step 2: README.md aktualisieren**

Im Endpoint-/Setup-Abschnitt Ollama als unterstützten lokalen Server nennen (Default LM Studio `:1234`, Ollama `:11434`; kein Provider-Setting nötig, einfach die URL eintragen; CORS-Hinweis `OLLAMA_ORIGINS`).

- [ ] **Step 3: CHANGELOG.md — Unreleased-Eintrag**

Unter einem `## [Unreleased]`-Abschnitt (ohne Datum!) ergänzen:

```markdown
### Added
- Ollama-Unterstützung ohne Provider-Setting: Kontextlängen-Sonde (`/api/show`),
  provider-übergreifende Thinking-Suppression, CORS-Non-Stream-Fallback,
  Always-on-Thinker-Erkennung (gpt-oss/harmony) mit run.md-Vermerk + Notice.

### Changed
- `LmStudioClient` → `LocalLlmClient` (provider-agnostischer Name).
```

- [ ] **Step 4: Verifizieren**

Run: `npm run gate`
Expected: PASS (Doku ändert keinen Code; Gate bleibt grün).

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md CHANGELOG.md
git commit -m "docs: Ollama-Unterstützung (Smoke-Schritt, README, CHANGELOG Unreleased)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manueller Smoke-Abschluss (nach Task 7)

Kein CI-Live-LLM (Spec §8). Nach allen Tasks:
1. `scripts/clone-vault.sh` → Wegwerf-Klon.
2. Plugin-Build hineinkopieren (`OBSIDIAN_PLUGIN_DIR=<Klon>/.obsidian/plugins/vault-crews npm run deploy`).
3. Ollama starten (`ollama serve`, Modell geladen), Endpoint in den Settings auf `http://localhost:11434/v1`.
4. „Install example crews" → eine Crew laufen lassen: Lauf endet `ok`, `run.md` plausibel. Ohne `OLLAMA_ORIGINS`: kein Live-Ticker, Ergebnis trotzdem da (Fallback griff).
5. Gegenprobe LM Studio `:1234` weiterhin grün (keine Regression).
6. Optional: Always-on-Modell (gpt-oss) laden → Notice + `always_on_thinker: true` in `run.md`.

## Self-Review-Notiz

- **Spec-Abdeckung:** model-info.ts (Task 1) ↔ Spec §1; Doppel-Sonde (Task 3) ↔ §2; Suppression (Task 4) ↔ §3.1; CORS-Fallback (Task 5) ↔ §3; Always-on (Task 6) ↔ §4; Rename (Task 2) ↔ §2; Doku/Smoke (Task 7) ↔ Spec „Offene Punkte".
- **Typkonsistenz:** `ModelContext`, `parseLmStudioContext`, `parseOllamaContext`, `suppressParams`, `isAlwaysOnThinker` einheitlich über Tasks 1/3/4/5/6; `LocalLlmClient` ab Task 2 durchgängig; `alwaysOnThinker` in RunState **und** RunResult (Task 6).
