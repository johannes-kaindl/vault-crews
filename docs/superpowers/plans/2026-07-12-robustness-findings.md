# Robustheit-Findings (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drei im 0.6.0-Smoke gefundene Zuverlässigkeits-Bugs beheben: HTTP-Fehler ehrlich klassifizieren, Fehler-Body lesbar machen, Always-on-Thinker zur Laufzeit erkennen.

**Architecture:** Rein repo-lokale Änderungen in `src/core` + `src/i18n`. Neue additive `ErrorKind` `endpoint_error`; neue pure Funktion `extractErrorMessage` in `chat-response.ts`; neues `reasoned`-Flag auf `LlmStreamResult` + Laufzeit-Detektion im Orchestrator. Kein Eingriff in vendored Kit-Module.

**Tech Stack:** TypeScript, Vitest (node-env, Obsidian-Mock via `resolve.alias`), esbuild.

## Global Constraints

- **Gate vor jedem Commit grün:** `npm run gate` = lint + typecheck + test + check:pure. Exit-Code prüfen, nicht grep.
- **`src/core/**` importiert NIE `obsidian`** (CI-Gate `check:pure`). Alle Fixes bleiben pure/core.
- **`ErrorKind` ist Single-Source:** Union in `src/core/types.ts` UND Laufzeit-Liste `ERROR_KINDS` in `src/core/run-log.ts` müssen konsistent bleiben.
- **`reasoning.ts` (vendored Kit) bleibt unverändert** — nur nutzen, nicht ändern (kein Kit-Promotion-Release).
- **Commit style:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **TDD:** je Bug erst der reproduzierende Fehltest.

---

### Task 1: D1 — HTTP-Fehler als `endpoint_error` klassifizieren

**Files:**
- Modify: `src/core/types.ts` (ErrorKind-Union, ~Z. 91)
- Modify: `src/core/run-log.ts` (ERROR_KINDS-Array, Z. 3-7)
- Modify: `src/core/orchestrator.ts` (`llmErrorKind`, Z. 542-552)
- Modify: `src/i18n/strings.ts` (en-Block ~Z. 109-119, de-Block ~Z. 282-292)
- Test: `tests/core/orchestrator.test.ts` (neuer Fall im Block `executeRun — llm call errors`)

**Interfaces:**
- Consumes: `ScriptLlmClient([{ error: 'http' }])`, `harness()`, `executeRun` (bestehend).
- Produces: `ErrorKind` enthält neu `'endpoint_error'`; `llmErrorKind(LlmCallError kind 'http')` liefert `'endpoint_error'`.

- [ ] **Step 1: Failing Test schreiben**

In `tests/core/orchestrator.test.ts`, im `describe('executeRun — llm call errors', …)` (nach dem `stall`-Test, ~Z. 250) einfügen:

```ts
it('http error → failed with errorKind endpoint_error (nicht endpoint_unreachable)', async () => {
  const llm = new ScriptLlmClient([{ error: 'http' }]);
  const h = await harness({ llm });
  const result = await executeRun(h.teamPath, h.deps);
  expect(result.status).toBe('failed');
  expect(result.errorKind).toBe('endpoint_error');
  expect(result.errorTask).toBe('analyse');
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run tests/core/orchestrator.test.ts -t "endpoint_error"`
Expected: FAIL — `errorKind` ist `'endpoint_unreachable'` (Ist-Wert), erwartet `'endpoint_error'`.

- [ ] **Step 3: `endpoint_error` in die ErrorKind-Union aufnehmen**

In `src/core/types.ts` die `ErrorKind`-Union (ab Z. 91) um `endpoint_error` ergänzen — direkt neben `endpoint_unreachable`:

```ts
export type ErrorKind =
	| 'endpoint_unreachable'
	| 'endpoint_error'
	| 'model_missing'
	| 'timeout'
	| 'stalled'
	| 'invalid_output'
	| 'context_overflow'
	| 'crew_invalid'
	| 'write_limit'
	| 'consistency'
	| 'aborted'
	| 'io';
```

(Falls die Union aktuell einzeilig/anders formatiert ist: nur den Member `'endpoint_error'` additiv einfügen, Format des Bestands beibehalten.)

- [ ] **Step 4: `ERROR_KINDS`-Laufzeitliste synchron halten**

In `src/core/run-log.ts` (Z. 3-7) `endpoint_error` nach `endpoint_unreachable` einfügen:

```ts
export const ERROR_KINDS: readonly ErrorKind[] = [
  'endpoint_unreachable', 'endpoint_error', 'model_missing', 'timeout', 'stalled',
  'invalid_output', 'context_overflow', 'crew_invalid',
  'write_limit', 'consistency', 'aborted', 'io',
];
```

- [ ] **Step 5: Mapping im Orchestrator umstellen**

In `src/core/orchestrator.ts`, Funktion `llmErrorKind` (Z. 542-552), den `http`-Case ändern:

```ts
function llmErrorKind(e: unknown): ErrorKind {
	if (e instanceof LlmCallError) {
		switch (e.kind) {
			case 'overflow': return 'context_overflow';
			case 'timeout': return 'timeout';
			case 'stalled': return 'stalled';
			case 'http': return 'endpoint_error';
		}
	}
	return 'io';
}
```

- [ ] **Step 6: i18n-Strings ergänzen (de + en)**

In `src/i18n/strings.ts` im **en**-Block direkt nach `"notice.errorKind.endpoint_unreachable"` (Z. 109):

```ts
  "notice.errorKind.endpoint_error": "The server rejected the call — see the run log for details.",
```

Im **de**-Block direkt nach der de-Variante von `endpoint_unreachable` (Z. 282):

```ts
  "notice.errorKind.endpoint_error": "Der Server hat den Aufruf abgelehnt — Details im Run-Log.",
```

- [ ] **Step 7: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run tests/core/orchestrator.test.ts -t "endpoint_error"`
Expected: PASS.

- [ ] **Step 8: Gate + Commit**

Run: `npm run gate` (Exit-Code 0 erwartet — u. a. verifiziert der TypeScript-Compiler, dass `notice.errorKind.endpoint_error` existiert, falls das i18n-Vokabular typisiert ist).

```bash
git add src/core/types.ts src/core/run-log.ts src/core/orchestrator.ts src/i18n/strings.ts tests/core/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
fix(orchestrator): HTTP-4xx/5xx als endpoint_error statt endpoint_unreachable

Ein HTTP-Fehlerstatus heißt: Server erreichbar, Request/Modell abgelehnt —
nicht "unreachable". Neue ErrorKind endpoint_error (4xx+5xx), Mapping
http→endpoint_error, i18n de+en. Behebt D1 aus dem 0.6.0-Smoke.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: D2 — Fehler-Body lesbar machen (`extractErrorMessage`)

**Files:**
- Modify: `src/core/chat-response.ts` (neue Funktion `extractErrorMessage`)
- Modify: `src/core/local-llm-client.ts` (Streaming-Pfad Z. 181-186, Non-Streaming-Pfad Z. 215-220)
- Test: `tests/core/chat-response.test.ts` (neuer `describe`-Block)
- Test: `tests/core/local-llm-client.test.ts` (neuer Fall im `describe('LocalLlmClient.stream', …)`)

**Interfaces:**
- Consumes: `isRecord` (modul-lokal in chat-response), `LlmCallError` (bestehend), `FakeSse`/`make`/`tickAsync` (Test-Helfer, bestehend).
- Produces: `extractErrorMessage(body: unknown): string | null` — exportiert aus `chat-response.ts`.

**Root-Cause (Kontext):** `run-log.ts` rendert Fehler mit `firstLine(message)`. LM Studios 400-Body ist pretty-printed JSON, dessen erste Zeile `{` ist → `HTTP 400: {`. Fix an der Quelle: die Message ist bereits einzeilig + sinnvoll.

- [ ] **Step 1: Failing Unit-Tests für `extractErrorMessage`**

In `tests/core/chat-response.test.ts` am Dateiende einen neuen Block ergänzen (Import oben um `extractErrorMessage` erweitern: `import { isContextOverflow, extractChatContent, extractErrorMessage } from '../../src/core/chat-response';`):

```ts
describe('extractErrorMessage', () => {
	it('zieht error.message (OpenAI/LM-Studio-Shape)', () => {
		expect(extractErrorMessage({ error: { message: "model 'foo' not loaded" } })).toBe("model 'foo' not loaded");
	});
	it('zieht error als String', () => {
		expect(extractErrorMessage({ error: 'bad request' })).toBe('bad request');
	});
	it('zieht top-level message', () => {
		expect(extractErrorMessage({ message: 'something failed' })).toBe('something failed');
	});
	it('null, wenn kein bekanntes Feld', () => {
		expect(extractErrorMessage({ foo: 'bar' })).toBeNull();
	});
	it('null für Nicht-Objekt', () => {
		expect(extractErrorMessage('plain text')).toBeNull();
		expect(extractErrorMessage(null)).toBeNull();
	});
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run tests/core/chat-response.test.ts -t "extractErrorMessage"`
Expected: FAIL — `extractErrorMessage is not a function` / Import-Fehler.

- [ ] **Step 3: `extractErrorMessage` implementieren**

In `src/core/chat-response.ts` vor der `isRecord`-Helferfunktion ergänzen:

```ts
/** Zieht eine sinnvolle einzeilige Fehler-Message aus einem (bereits geparsten)
 *  JSON-Fehlerbody. Reihenfolge: error.message → error (String) → message.
 *  null, wenn kein bekanntes Feld greift (Aufrufer nutzt dann den Rohbody).
 *  Verhindert D2: firstLine() kollabierte pretty-printed JSON auf "{". */
export function extractErrorMessage(body: unknown): string | null {
	if (!isRecord(body)) return null;
	const err = body.error;
	if (isRecord(err) && typeof err.message === 'string') return err.message;
	if (typeof err === 'string') return err;
	if (typeof body.message === 'string') return body.message;
	return null;
}
```

- [ ] **Step 4: Unit-Tests laufen lassen, Erfolg bestätigen**

Run: `npx vitest run tests/core/chat-response.test.ts -t "extractErrorMessage"`
Expected: PASS.

- [ ] **Step 5: In den Streaming-Pfad des Clients einbauen**

In `src/core/local-llm-client.ts`:

Import (Z. 10) erweitern:
```ts
import { isContextOverflow, extractChatContent, extractErrorMessage } from './chat-response';
```

Am Dateiende (bei den freien Helfern, nach `thinkTokens`) zwei kleine Helfer ergänzen:
```ts
function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

function tryJson(s: string): unknown {
	try { return JSON.parse(s) as unknown; } catch { return null; }
}
```

Den Streaming-Fehlerpfad (aktuell Z. 181-186) ersetzen:
```ts
		if (status !== 200) {
			if (isContextOverflow(rawBody)) {
				throw new LlmCallError(`HTTP ${status}: Kontextfenster überschritten`, 'overflow');
			}
			const detail = extractErrorMessage(tryJson(rawBody)) ?? rawBody.slice(0, 300);
			throw new LlmCallError(`HTTP ${status}: ${oneLine(detail)}`, 'http');
		}
```

- [ ] **Step 6: In den Non-Streaming-Pfad einbauen**

In `src/core/local-llm-client.ts` den Non-Streaming-Fehlerpfad (aktuell Z. 215-220) ersetzen:
```ts
		// Kein content extrahierbar → das ist ein echter Fehlerbody, hier erst auf Overflow sniffen.
		const rawBody = JSON.stringify(res ?? {});
		if (isContextOverflow(rawBody)) {
			throw new LlmCallError('Kontextfenster überschritten (Non-Streaming)', 'overflow');
		}
		const detail = extractErrorMessage(res) ?? oneLine(rawBody.slice(0, 300));
		throw new LlmCallError(`Non-Streaming-Antwort ohne content: ${oneLine(detail)}`, 'http');
```

- [ ] **Step 7: Failing Client-Integrationstest schreiben**

In `tests/core/local-llm-client.test.ts` im `describe('LocalLlmClient.stream', …)` ergänzen:

```ts
	it('400 mit pretty-printed JSON-Body → lesbare einzeilige Message (nicht "{")', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.emit('{\n  "error": {\n    "message": "model \'foo\' not loaded"\n  }\n}');
		sse.end(400);
		await expect(p).rejects.toMatchObject({ kind: 'http' });
		const err = await p.catch((e: unknown) => e as LlmCallError);
		expect(err.message).toContain("model 'foo' not loaded");
		expect(err.message).not.toContain('\n');
	});
```

- [ ] **Step 8: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "lesbare einzeilige Message"`
Expected: PASS. (Ist-Verhalten vor dem Fix wäre `HTTP 400: {` gewesen — enthält Newline / nicht die Message.)

- [ ] **Step 9: Gate + Commit**

Run: `npm run gate` (Exit-Code 0 erwartet).

```bash
git add src/core/chat-response.ts src/core/local-llm-client.ts tests/core/chat-response.test.ts tests/core/local-llm-client.test.ts
git commit -m "$(cat <<'EOF'
fix(llm-client): lesbarer Fehler-Body via extractErrorMessage

firstLine() kollabierte pretty-printed JSON-Fehlerbodies auf "{" ("HTTP 400: {").
Neue pure extractErrorMessage zieht error.message/error/message → einzeilige
Message, oneLine() hält den Rohbody-Fallback newline-frei. Behebt D2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: D3 — Always-on-Thinker zur Laufzeit erkennen (`reasoned`-Flag)

**Files:**
- Modify: `src/core/ports.ts` (`LlmStreamResult`, Z. 31)
- Modify: `src/core/local-llm-client.ts` (5 Return-Sites: Z. 171, 187, 200, 210, 213; Import `reasoningHappened`)
- Modify: `src/core/orchestrator.ts` (`runLlmTask` — nach Primär- und Repair-Ergebnis)
- Modify: `src/i18n/strings.ts` (`notice.run.alwaysOnThinker` de + en modell-agnostisch)
- Modify: `tests/helpers/script-llm.ts` (`ScriptedCall.reasoned` + Return-Site)
- Modify: `tests/core/orchestrator.test.ts` (2 Inline-Fakes `ClockAdvancingLlm` Z. 127, `AbortMidStreamLlm` Z. 139: `reasoned: false`)
- Test: `tests/core/local-llm-client.test.ts` (`reasoned`-Assertions)
- Test: `tests/core/orchestrator.test.ts` (neuer Detektions-Fall)

**Interfaces:**
- Consumes: `reasoningHappened(content, reasoning)` aus `../vendor/kit/reasoning` (bestehend, unverändert); `ScriptLlmClient`, `harness`, `executeRun`.
- Produces: `LlmStreamResult.reasoned: boolean`; `ScriptedCall.reasoned?: boolean`.

- [ ] **Step 1: `reasoned` auf `LlmStreamResult` (Vertrag zuerst) + Testdoubles nachziehen**

In `src/core/ports.ts` Z. 31:
```ts
export interface LlmStreamResult { content: string; thinkTokens: number; reasoned: boolean; finishReason: 'stop' | 'length' | 'aborted'; }
```

In `tests/helpers/script-llm.ts`: `ScriptedCall` um `reasoned?: boolean;` erweitern und die Return-Site (Z. 29):
```ts
		return { content, thinkTokens: step.thinkTokens ?? 0, reasoned: step.reasoned ?? false, finishReason: step.finishReason ?? 'stop' };
```

In `tests/core/orchestrator.test.ts` die zwei Inline-Fakes:
- `ClockAdvancingLlm` (Z. 127): `return { content: this.content, thinkTokens: 0, reasoned: false, finishReason: 'stop' };`
- `AbortMidStreamLlm` (Z. 139): `return { content: '', thinkTokens: 0, reasoned: false, finishReason: 'aborted' };`

- [ ] **Step 2: Failing Client-Tests für `reasoned`**

In `tests/core/local-llm-client.test.ts` im `describe('LocalLlmClient.stream', …)` ergänzen:

```ts
	it('reasoned=true wenn das Modell gedacht hat (reasoning.sse)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('reasoning.sse'));
		const r = await p;
		expect(r.reasoned).toBe(true);
	});

	it('reasoned=false ohne Reasoning (basic.sse)', async () => {
		const { client, sse, clock } = make();
		const p = client.stream([{ role: 'user', content: 'q' }], PARAMS, () => {}, new AbortController().signal);
		await tickAsync(clock, 1);
		sse.play(fixture('basic.sse'));
		const r = await p;
		expect(r.reasoned).toBe(false);
	});
```

- [ ] **Step 3: Client-Tests laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "reasoned"`
Expected: FAIL — `reasoned` fehlt im Ergebnis (bzw. TS-Compile-Fehler in Step-1-noch-nicht-gesetzten Client-Sites).

- [ ] **Step 4: Client-Return-Sites `reasoned` setzen**

In `src/core/local-llm-client.ts` Import (Z. 6-9-Bereich) ergänzen:
```ts
import { reasoningHappened } from '../vendor/kit/reasoning';
```

Die fünf Return-Sites im Client anpassen:
- Z. 171 (Streaming, aborted): `return { content, thinkTokens: thinkTokens(reasoningText), reasoned: reasoningHappened(content, reasoningText), finishReason: 'aborted' };`
- Z. 187 (Streaming, stop): `return { content, thinkTokens: thinkTokens(reasoningText), reasoned: reasoningHappened(content, reasoningText), finishReason: 'stop' };`
- Z. 200 (Non-Streaming, früher Abort): `if (signal.aborted) return { content: '', thinkTokens: 0, reasoned: false, finishReason: 'aborted' };`
- Z. 210 (Non-Streaming, Abort nach Call): `if (signal.aborted) return { content: '', thinkTokens: 0, reasoned: false, finishReason: 'aborted' };`
- Z. 213 (Non-Streaming, stop): `return { content: extracted.content, thinkTokens: thinkTokens(extracted.reasoning), reasoned: reasoningHappened(extracted.content, extracted.reasoning), finishReason: 'stop' };`

- [ ] **Step 5: Client-Tests laufen lassen, Erfolg bestätigen**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "reasoned"`
Expected: PASS.

- [ ] **Step 6: Failing Orchestrator-Detektionstest**

In `tests/core/orchestrator.test.ts` im Block `executeRun — llm call errors` NICHT — sondern einen neuen `describe` am Ende der Datei oder im happy-path-Bereich. Konkret nach `describe('executeRun — llm call errors', …)` einfügen:

```ts
describe('executeRun — always-on-thinker Laufzeit-Detektion', () => {
  it('thinking off, aber Modell hat gedacht → alwaysOnThinker true (Name matcht Regex nicht)', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: true }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'off' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.status).toBe('ok');
    expect(result.alwaysOnThinker).toBe(true);
  });

  it('thinking off + kein Reasoning → alwaysOnThinker false', async () => {
    const llm = new ScriptLlmClient([{ content: TRIAGE_OK, reasoned: false }]);
    const h = await harness({
      llm,
      agents: { 'triage-analyst': { fm: { 'crew-kind': 'agent', name: 'A', thinking: 'off' }, body: 'x' } },
    });
    const result = await executeRun(h.teamPath, h.deps);
    expect(result.alwaysOnThinker).toBe(false);
  });
});
```

- [ ] **Step 7: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run tests/core/orchestrator.test.ts -t "always-on-thinker Laufzeit"`
Expected: FAIL — erster Fall erwartet `true`, Ist ist `false` (Namens-Regex greift bei 'test-model' nicht, Laufzeit-Detektion fehlt noch).

- [ ] **Step 8: Laufzeit-Detektion im Orchestrator**

In `src/core/orchestrator.ts`, `runLlmTask`: nach der `rec.thinkTokens += result.thinkTokens;`-Zeile (Z. 271) die Detektion ergänzen:

```ts
		rec.thinkTokens += result.thinkTokens;
		if (params.thinking === 'off' && result.reasoned) this.state.alwaysOnThinker = true;
```

Und im Repair-Zweig analog nach `rec.thinkTokens += repair.thinkTokens;` (Z. 280):

```ts
			rec.thinkTokens += repair.thinkTokens;
			if (params.thinking === 'off' && repair.reasoned) this.state.alwaysOnThinker = true;
```

- [ ] **Step 9: i18n-String modell-agnostisch machen**

In `src/i18n/strings.ts` `notice.run.alwaysOnThinker`:
- en (Z. 99): `"notice.run.alwaysOnThinker": "This model kept reasoning despite 'thinking: off' — suppression does not fully apply.",`
- de (Z. 273): `"notice.run.alwaysOnThinker": "Dieses Modell hat trotz 'thinking: off' weitergedacht — die Unterdrückung greift nicht vollständig.",`

- [ ] **Step 10: Orchestrator-Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run tests/core/orchestrator.test.ts -t "always-on-thinker Laufzeit"`
Expected: PASS (beide Fälle).

- [ ] **Step 11: Gate + Commit**

Run: `npm run gate` (Exit-Code 0 erwartet — voller Testlauf verifiziert, dass die `reasoned`-Pflichtfeld-Änderung keine weitere Konstruktionsstelle bricht).

```bash
git add src/core/ports.ts src/core/local-llm-client.ts src/core/orchestrator.ts src/i18n/strings.ts tests/helpers/script-llm.ts tests/core/local-llm-client.test.ts tests/core/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
fix(orchestrator): Always-on-Thinker zur Laufzeit erkennen (reasoned-Flag)

isAlwaysOnThinker matcht nur gpt-oss/harmony per Name; ornith denkt trotz
'thinking: off' weiter und fiel durch. Neues reasoned-Flag auf LlmStreamResult;
Orchestrator setzt alwaysOnThinker, wenn Suppression angefordert war, das Modell
aber gedacht hat. Namens-Regex bleibt als Preflight-Hinweis. Notice-Text
modell-agnostisch. Behebt D3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- D1 (endpoint_error) → Task 1 ✓ (types, ERROR_KINDS, Mapping, i18n)
- D2 (extractErrorMessage + lesbarer Body) → Task 2 ✓ (pure Funktion + beide Client-Pfade + Integrationstest)
- D3 (reasoned + Laufzeit-Detektion + modell-agnostische Notice) → Task 3 ✓
- Invariante „kein obsidian-Import in core" → alle Änderungen in core/i18n ✓
- Invariante „reasoning.ts unverändert" → nur `reasoningHappened` genutzt ✓
- Invariante „ErrorKind Single-Source" → Task 1 Steps 3+4 halten Union + ERROR_KINDS synchron ✓

**2. Placeholder scan:** Kein TBD/TODO; alle Code-Blöcke vollständig; alle Testkörper konkret.

**3. Type consistency:** `extractErrorMessage(body: unknown): string | null` in Task 2 definiert, in Client (Step 5/6) identisch genutzt. `LlmStreamResult.reasoned: boolean` in Task 3 Step 1 definiert, an 5 Client-Sites + 2 Fakes + ScriptLlmClient gesetzt, im Orchestrator + Tests gelesen. `ScriptedCall.reasoned?: boolean` konsistent. `ErrorKind`-Member `'endpoint_error'` in Union + ERROR_KINDS + Mapping + i18n identisch.
