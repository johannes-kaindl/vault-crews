# Chat-Response-Split: pure Response-Interpretation aus LocalLlmClient herauslösen

**Datum:** 2026-07-11
**Status:** Design (approved)
**Scope:** Repo-lokaler Refactor, kein Verhaltenswechsel, kein Kit-Release.

## Problem

`src/core/local-llm-client.ts` vermengt zwei Verantwortlichkeiten:

1. **Transport-Orchestrierung** — Streaming über `SseTransport` (Timer, Abort,
   SSE-Akkumulation), Non-Streaming-Fallback über `JsonTransport`.
2. **Response-Interpretation** — Content aus einer `/v1/chat/completions`-Antwort
   ziehen und (Fehler-)Bodies auf Kontextfenster-Overflow klassifizieren.

Zwei konkrete Symptome:

- **Regex-Dublette:** Die Overflow-Heuristik
  `/context (length|window)|too many tokens/i` steht wörtlich zweimal — im
  Streaming-Pfad (`local-llm-client.ts:181`) und im Non-Streaming-Fallback
  (`:220`). Ändert jemand die eine, driftet die andere unbemerkt.
- **Verhedderte Concerns:** Die Response-Parsing-Logik (`choices[0].message.content`
  extrahieren, `reasoning_content` mitnehmen, content-first-then-sniff gegen
  False-Positives) lebt inline im Client und ist nur indirekt — durch den ganzen
  Client mit Fake-Transports — testbar.

Kein Bug: Der Pfad ist getestet (`tests/core/local-llm-client.test.ts:180-237`) und
lief im Ollama-Smoke grün. Dies ist ein **Qualitäts-/Dedup-Refactor**.

## Nicht-Ziele (YAGNI)

- **Kein Kit-Promotion jetzt.** Die pure Logik ist providerübergreifend und damit
  ein späterer Kit-Kandidat (wie `model-context.ts`), aber ohne konkreten
  zweiten Consumer (vault-rag dockt heute nicht an) bleibt sie repo-lokal.
  Promotion später, falls ein zweites Exemplar auftaucht.
- **Kein Zusammenlegen der Content-Extraktion beider Pfade.** Der Streaming-Pfad
  akkumuliert Content über `parseSSE` + `ThinkSplitter` — ein grundverschiedener
  Mechanismus. Geteilt wird **nur** die Overflow-Klassifikation; die
  Non-Streaming-Content-Extraktion wird lediglich *entheddert*, nicht mit dem
  Streaming-Pfad verschmolzen.
- **Kein Transport-/CORS-Verhaltenswechsel.** Der XHR→`requestUrl`-Fallback bei
  CORS-Refusal bleibt exakt wie er ist.

## Design

Neues pures Modul `src/core/chat-response.ts` mit einer klaren Verantwortung:
OpenAI-kompatible Chat-Completion-Responses interpretieren. Kein `obsidian`-Import,
fällt unter das `check:pure`-Gate.

### Öffentliche Oberfläche

```ts
/** True, wenn der (Fehler-)Body auf ein überschrittenes Kontextfenster hindeutet.
 *  Geteilt zwischen Streaming- und Non-Streaming-Pfad — die eine Quelle der
 *  Overflow-Heuristik. */
export function isContextOverflow(body: string): boolean;

/** Zieht content + reasoning aus einer Non-Streaming /v1/chat/completions-Antwort.
 *  Gibt null zurück, wenn kein content extrahierbar ist (echter Fehlerbody);
 *  der Aufrufer klassifiziert dann via isContextOverflow. */
export function extractChatContent(res: unknown): { content: string; reasoning: string } | null;
```

`isContextOverflow` kapselt die Regex `/context (length|window)|too many tokens/i`.
`extractChatContent` übernimmt die heutige Logik aus `streamNonStreaming`
(`local-llm-client.ts:210-217`): `choices[0].message.content` als String,
`reasoning_content` optional, sonst `null`. Der dafür nötige `isRecord`-Guard
zieht als modul-lokaler Helper mit ins pure Modul.

### Verdrahtung in `local-llm-client.ts`

| Stelle | Vorher | Nachher |
|--------|--------|---------|
| Streaming, `:180-184` | Inline-Regex auf `rawBody` | `if (isContextOverflow(rawBody))` |
| Non-Streaming, `:210-217` | Inline `choices`/`message`/`content`-Parsing | `extractChatContent(res)` |
| Non-Streaming, `:218-223` | Inline-Regex auf `JSON.stringify(res)` | `if (isContextOverflow(JSON.stringify(res ?? {})))` |

`thinkTokens` bleibt im Client (Token-Accounting, keine Response-Shape). Der
lokale `isRecord` im Client bleibt, solange andere Stellen ihn nutzen
(`listModels`, `modelInfo`); die pure Modul-Kopie ist bewusst eigenständig,
damit das Modul keine Abhängigkeit zurück in den Client hat.

### Verhalten (invariant)

Die content-first-then-sniff-Reihenfolge bleibt erhalten: Erst
`extractChatContent`; nur wenn das `null` liefert (kein Content = echter
Fehlerbody), wird via `isContextOverflow` gesnifft. Damit wird eine erfolgreiche
Antwort, die „context window" im Fließtext erwähnt, weiterhin **nicht**
fälschlich als Overflow klassifiziert.

## Tests

TDD, erst rot. Neue `tests/core/chat-response.test.ts` mit direkten Unit-Tests:

**`isContextOverflow`:**
- `true` für „context length" / „context window" / „too many tokens" (case-insensitive)
- `false` für unverdächtige Fehlerbodies
- `false` für leeren String

**`extractChatContent`:**
- Extrahiert `content` + `reasoning_content` aus wohlgeformter Antwort
- `reasoning` = `''`, wenn `reasoning_content` fehlt
- `null` bei fehlendem `choices`/`message`/`content`
- `null` bei nicht-objekt-Input (`null`, Array, String)

Die bestehenden 4 Verhaltenstests in `local-llm-client.test.ts:180-237` bleiben
**unverändert** und laufen als Integrationsschicht mit — Doppelabsicherung, dass
die Verdrahtung das Verhalten nicht verschoben hat.

## Definition of Done

- [ ] `src/core/chat-response.ts` mit beiden Funktionen, pur, kein `obsidian`-Import.
- [ ] `local-llm-client.ts` nutzt beide Funktionen; keine Overflow-Regex mehr im Client.
- [ ] `tests/core/chat-response.test.ts` grün (direkte Unit-Tests).
- [ ] Bestehende Tests unverändert grün.
- [ ] `npm run gate` grün (lint + typecheck + test + check:pure), Exit-Code geprüft.
