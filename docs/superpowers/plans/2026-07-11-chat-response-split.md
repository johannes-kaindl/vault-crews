# Chat-Response-Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die pure Response-Interpretation (Overflow-Klassifikation + Non-Streaming-Content-Extraktion) aus `LocalLlmClient` in ein eigenes pures Modul `src/core/chat-response.ts` herauslösen — Regex-Dublette beseitigen, Concerns entheddern, ohne Verhaltenswechsel.

**Architecture:** Neues pures Modul mit zwei Funktionen (`isContextOverflow`, `extractChatContent`), direkt unit-getestet. `LocalLlmClient` verdrahtet beide an drei Stellen; die bestehenden 4 Verhaltenstests bleiben als Integrationsnetz unverändert grün.

**Tech Stack:** TypeScript, Vitest (node-env), esbuild. Kein neuer Dependency.

## Global Constraints

- `src/core/**` importiert NIE `obsidian` (CI-Gate `check:pure`). `chat-response.ts` ist rein.
- **Gate vor jedem Commit grün:** `npm run gate` (lint + typecheck + test + check:pure). Exit-Code prüfen, nicht grep-Ausgabe.
- **TDD:** erst fehlschlagender Test, dann minimale Implementierung.
- **Commit style:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Kein Verhaltenswechsel:** content-first-then-sniff-Reihenfolge und alle Fehler-Kinds (`overflow`/`http`) bleiben byte-identisch zum Ist-Zustand.

---

### Task 1: Pures Modul `chat-response.ts`

**Files:**
- Create: `src/core/chat-response.ts`
- Test: `tests/core/chat-response.test.ts`

**Interfaces:**
- Consumes: nichts (Blattmodul).
- Produces:
  - `isContextOverflow(body: string): boolean`
  - `extractChatContent(res: unknown): { content: string; reasoning: string } | null`

- [ ] **Step 1: Failing-Test schreiben**

`tests/core/chat-response.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isContextOverflow, extractChatContent } from '../../src/core/chat-response';

describe('isContextOverflow', () => {
	it('erkennt "context length"', () => {
		expect(isContextOverflow('this request exceeds the model context length of 8192 tokens')).toBe(true);
	});
	it('erkennt "context window" case-insensitive', () => {
		expect(isContextOverflow('CONTEXT WINDOW exceeded')).toBe(true);
	});
	it('erkennt "too many tokens"', () => {
		expect(isContextOverflow('error: too many tokens')).toBe(true);
	});
	it('false für unverdächtigen Fehlerbody', () => {
		expect(isContextOverflow('{"error":"model not found"}')).toBe(false);
	});
	it('false für leeren String', () => {
		expect(isContextOverflow('')).toBe(false);
	});
});

describe('extractChatContent', () => {
	it('extrahiert content + reasoning_content', () => {
		const res = { choices: [{ message: { content: 'Hallo', reasoning_content: 'denk' } }] };
		expect(extractChatContent(res)).toEqual({ content: 'Hallo', reasoning: 'denk' });
	});
	it('reasoning = "" wenn reasoning_content fehlt', () => {
		const res = { choices: [{ message: { content: 'Hallo' } }] };
		expect(extractChatContent(res)).toEqual({ content: 'Hallo', reasoning: '' });
	});
	it('null bei fehlendem content', () => {
		expect(extractChatContent({ choices: [{ message: {} }] })).toBeNull();
	});
	it('null bei fehlenden choices', () => {
		expect(extractChatContent({ error: { message: 'context length exceeded' } })).toBeNull();
	});
	it('null bei nicht-objekt-Input', () => {
		expect(extractChatContent(null)).toBeNull();
		expect(extractChatContent([])).toBeNull();
		expect(extractChatContent('string')).toBeNull();
	});
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag verifizieren**

Run: `npx vitest run tests/core/chat-response.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/chat-response'`.

- [ ] **Step 3: Minimale Implementierung**

`src/core/chat-response.ts`:

```ts
/** Pure Interpretation OpenAI-kompatibler Chat-Completion-Responses.
 *  Kein Transport, kein Streaming — nur Response-Shape + Fehler-Klassifikation.
 *  Kein `obsidian`-Import (check:pure). */

const OVERFLOW_RE = /context (length|window)|too many tokens/i;

/** True, wenn der (Fehler-)Body auf ein überschrittenes Kontextfenster hindeutet.
 *  Geteilt zwischen Streaming- und Non-Streaming-Pfad des LocalLlmClient. */
export function isContextOverflow(body: string): boolean {
	return OVERFLOW_RE.test(body);
}

/** Zieht content + reasoning aus einer Non-Streaming /v1/chat/completions-Antwort.
 *  null, wenn kein content extrahierbar ist (echter Fehlerbody) — der Aufrufer
 *  klassifiziert dann via isContextOverflow. */
export function extractChatContent(res: unknown): { content: string; reasoning: string } | null {
	const choices = isRecord(res) && Array.isArray(res.choices) ? (res.choices as unknown[]) : [];
	const choice = choices.length > 0 ? choices[0] : null;
	const msg = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
	const content = msg && typeof msg.content === 'string' ? msg.content : null;
	if (content === null) return null;
	const reasoning = msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
	return { content, reasoning };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: Test laufen lassen, grün verifizieren**

Run: `npx vitest run tests/core/chat-response.test.ts`
Expected: PASS (10 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/chat-response.ts tests/core/chat-response.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-response): pures Modul für Overflow-Klassifikation + Content-Extraktion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `LocalLlmClient` an das pure Modul verdrahten

**Files:**
- Modify: `src/core/local-llm-client.ts` (Import + `:180-185` Streaming + `:194-224` `streamNonStreaming`)
- Test: `tests/core/local-llm-client.test.ts` (unverändert — dient als Integrationsnetz)

**Interfaces:**
- Consumes: `isContextOverflow`, `extractChatContent` aus Task 1.
- Produces: keine neue öffentliche API (rein interne Verdrahtung).

- [ ] **Step 1: Bestehende Verhaltenstests als Netz laufen lassen (Baseline grün)**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS. Das ist die Baseline — dieselben Tests müssen nach der Verdrahtung unverändert grün bleiben (Beweis: kein Verhaltenswechsel).

- [ ] **Step 2: Import ergänzen**

In `src/core/local-llm-client.ts` nach den bestehenden Core-Imports (unter der `./model-info`-Zeile) einfügen:

```ts
import { isContextOverflow, extractChatContent } from './chat-response';
```

- [ ] **Step 3: Streaming-Pfad verdrahten**

In `stream()` den `status !== 200`-Block (aktuell `:180-185`) ersetzen. Vorher:

```ts
		if (status !== 200) {
			if (/context (length|window)|too many tokens/i.test(rawBody)) {
				throw new LlmCallError(`HTTP ${status}: Kontextfenster überschritten`, 'overflow');
			}
			throw new LlmCallError(`HTTP ${status}: ${rawBody.slice(0, 300)}`, 'http');
		}
```

Nachher:

```ts
		if (status !== 200) {
			if (isContextOverflow(rawBody)) {
				throw new LlmCallError(`HTTP ${status}: Kontextfenster überschritten`, 'overflow');
			}
			throw new LlmCallError(`HTTP ${status}: ${rawBody.slice(0, 300)}`, 'http');
		}
```

- [ ] **Step 4: Non-Streaming-Pfad verdrahten**

In `streamNonStreaming()` den Block ab `const res = await this.json.postJson(...)` bis zum Ende (aktuell `:208-223`) ersetzen. Vorher:

```ts
		const res = await this.json.postJson(`${this.base}/v1/chat/completions`, body);
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const choices = isRecord(res) && Array.isArray(res.choices) ? (res.choices as unknown[]) : [];
		const choice = choices.length > 0 ? choices[0] : null;
		const msg = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
		const content = msg && typeof msg.content === 'string' ? msg.content : null;
		if (content !== null) {
			const reasoning = msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
			return { content, thinkTokens: thinkTokens(reasoning), finishReason: 'stop' };
		}
		// Kein content extrahierbar → das ist ein echter Fehlerbody, hier erst auf Overflow sniffen.
		const rawBody = JSON.stringify(res ?? {});
		if (/context (length|window)|too many tokens/i.test(rawBody)) {
			throw new LlmCallError('Kontextfenster überschritten (Non-Streaming)', 'overflow');
		}
		throw new LlmCallError(`Non-Streaming-Antwort ohne content: ${rawBody.slice(0, 300)}`, 'http');
```

Nachher:

```ts
		const res = await this.json.postJson(`${this.base}/v1/chat/completions`, body);
		if (signal.aborted) return { content: '', thinkTokens: 0, finishReason: 'aborted' };
		const extracted = extractChatContent(res);
		if (extracted !== null) {
			return { content: extracted.content, thinkTokens: thinkTokens(extracted.reasoning), finishReason: 'stop' };
		}
		// Kein content extrahierbar → das ist ein echter Fehlerbody, hier erst auf Overflow sniffen.
		const rawBody = JSON.stringify(res ?? {});
		if (isContextOverflow(rawBody)) {
			throw new LlmCallError('Kontextfenster überschritten (Non-Streaming)', 'overflow');
		}
		throw new LlmCallError(`Non-Streaming-Antwort ohne content: ${rawBody.slice(0, 300)}`, 'http');
```

Hinweis: Der modul-lokale `isRecord`-Helper in `local-llm-client.ts` bleibt — er wird weiterhin von `listModels`/`modelInfo` genutzt. Nur die zwei inline-Nutzungen in `streamNonStreaming` fallen weg.

- [ ] **Step 5: Integrationstests laufen lassen, unverändert grün verifizieren**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS — dieselben Tests wie in Step 1, unverändert grün. Insbesondere:
- „HTTP 400 mit context-length-Hinweis → LlmCallError overflow" (`:180`)
- „erkennt Context-Overflow im Fallback-Body" (`:215`)
- „klassifiziert erfolgreichen Fallback-Content mit ‚context window' nicht als Overflow" (`:226`)

- [ ] **Step 6: Volles Gate**

Run: `npm run gate`
Expected: Exit-Code 0 (lint + typecheck + test + check:pure grün). `check:pure` bestätigt, dass `chat-response.ts` kein `obsidian` importiert.

- [ ] **Step 7: Commit**

```bash
git add src/core/local-llm-client.ts
git commit -m "$(cat <<'EOF'
refactor(local-llm-client): Response-Interpretation an pures chat-response-Modul delegieren

Beseitigt die doppelte Overflow-Regex (Streaming + Non-Streaming) und entheddert
die Content-Extraktion. Kein Verhaltenswechsel — bestehende Verhaltenstests
unverändert grün.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec-Coverage:**
- „Regex-Dublette beseitigen" → Task 1 (`isContextOverflow`) + Task 2 Steps 3–4 (beide Stellen verdrahtet). ✓
- „Content-Extraktion entheddern" → Task 1 (`extractChatContent`) + Task 2 Step 4. ✓
- „direkte Unit-Tests" → Task 1 Step 1. ✓
- „bestehende Tests unverändert grün" → Task 2 Steps 1 + 5. ✓
- „`check:pure`" → Global Constraints + Task 2 Step 6. ✓
- Verhaltens-Invariante (content-first-then-sniff) → in beiden Modul-Code + Test „context window im Erfolgs-Content" abgedeckt. ✓

**Placeholder-Scan:** kein TBD/TODO; jeder Code-Step zeigt vollständigen Code. ✓

**Typ-Konsistenz:** `isContextOverflow(string): boolean` und `extractChatContent(unknown): {content, reasoning} | null` sind in Spec, Task 1 (Definition) und Task 2 (Nutzung: `extracted.content`/`extracted.reasoning`) identisch benannt und typisiert. ✓
