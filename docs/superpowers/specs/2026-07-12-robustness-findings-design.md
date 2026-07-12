# Robustheit-Findings (P1 des UX-Pakets) — Design

**Datum:** 2026-07-12
**Status:** Design (Spec)
**Scope:** Teilprojekt 1 von 3 des „UX-Pakets / Run-Panel-v2". P2 = Live-Streaming-Sidebar,
P3 = Retry — **nicht** Teil dieses Specs.

## Kontext

Der Release-Smoke von 0.6.0 (2026-07-12) förderte drei Zuverlässigkeits-/Wahrheits-Bugs
zutage, die Unit- und Parser-Tests verpasst haben. Alle drei betreffen die Ehrlichkeit der
Fehler-/Statusmeldung gegenüber dem Nutzer — der Lauf selbst bleibt sicher (Commit + Log),
aber die *Erklärung* ist falsch oder unlesbar. Dieses Teilprojekt behebt genau diese drei
Findings, rein repo-lokal, ohne Änderung an vendored Kit-Modulen.

## Die drei Findings

### D1 · HTTP-4xx/5xx wird als `endpoint_unreachable` fehlklassifiziert

**Ist:** `orchestrator.ts` `llmErrorKind()` mappt `LlmCallError.kind === 'http'` pauschal auf
`endpoint_unreachable`. Ein HTTP-400 (oder 500) bedeutet aber: der Server ist **erreichbar**
und hat den Request bzw. das Modell abgelehnt — das Gegenteil von „unreachable". Der Nutzer
bekommt die Next-Action *„LM Studio starten, dann erneut ausführen"*, obwohl LM Studio läuft.

**Soll:** Neue `ErrorKind` **`endpoint_error`** = „Server erreicht, hat einen Fehlerstatus
geliefert" (deckt 4xx **und** 5xx ab; der konkrete Status steckt in der Fehler-Message).
Abgegrenzt von `endpoint_unreachable` = „keine Verbindung zustande gekommen".

**Entscheidung (bestätigt):** *Eine* Klasse `endpoint_error` für 4xx+5xx (nicht getrennt in
`bad_request`/`server_error`) — der HTTP-Status trägt die Message, ein zusätzlicher Kind für
den selteneren 5xx-Fall lohnt das Vokabular nicht.

**Touch points:**
- `src/core/types.ts` — `endpoint_error` in die `ErrorKind`-Union.
- `src/core/run-log.ts` — `endpoint_error` in `ERROR_KINDS` (Single-Source-Liste).
- `src/core/orchestrator.ts` — `llmErrorKind()`: `case 'http': return 'endpoint_error';`.
- `src/i18n/strings.ts` — `notice.errorKind.endpoint_error` (de + en), z. B.
  DE: *„Der Server hat den Aufruf abgelehnt — Details im Run-Log."*
  EN: *„The server rejected the call — see the run log for details."*
- Kein Panel-Change nötig: `panel-view-model.ts` `nextActionText()` liest
  `t('notice.errorKind.' + errorKind)` generisch, sobald der String existiert.

### D2 · Fehler-Body abgeschnitten (`HTTP 400: {`)

**Root-Cause (bestätigt):** `run-log.ts` rendert Fehler mit `firstLine(rec.error.message)`.
LM Studios 400-Body ist pretty-printed JSON, dessen erste Zeile `{` ist. Die Fehler-Message
lautet `HTTP 400: {\n  "error": …}` (aus `local-llm-client.ts`), `firstLine()` kappt sie auf
`HTTP 400: {`. Kein Transport- oder `slice()`-Problem — die Kürzung entsteht beim Rendern.

**Soll:** Die Fehler-Message ist bereits an der Quelle eine **sinnvolle einzeilige** Aussage,
sodass `firstLine()` (bewusst, hält run.md aufgeräumt) etwas Lesbares behält.

**Fix:** Neue pure Funktion `extractErrorMessage(body: unknown): string | null` in
`src/core/chat-response.ts` (passt zur Nachbarschaft von `extractChatContent`/`isContextOverflow`).
Sie zieht in dieser Reihenfolge: `body.error.message` → `body.error` (String) → `body.message`.
`local-llm-client.ts` baut die Message dann als
`HTTP ${status}: ${extractErrorMessage(parsedBody) ?? oneLine(rawBody.slice(0, 300))}`, wobei
`oneLine()` Zeilenumbrüche durch Leerzeichen ersetzt (Fallback bleibt so auch newline-frei).

**Touch points:**
- `src/core/chat-response.ts` — `extractErrorMessage()` (+ interner `oneLine`-Helfer oder in Client).
- `src/core/local-llm-client.ts` — Streaming-Pfad (Zeile ~185) und Non-Streaming-Pfad (~220)
  bauen die `LlmCallError`-Message über `extractErrorMessage` statt roher `slice`.
- `run-log.ts` bleibt unverändert (`firstLine()` ist jetzt korrekt gefüttert).

### D3 · Always-on-Thinker nicht erkannt (ornith)

**Ist:** `isAlwaysOnThinker` (vendored `reasoning.ts`) erkennt Always-on-Denker nur über einen
**Namens**-Regex (`gpt-oss|harmony`). Modelle wie *ornith* denken trotz `thinking: off` weiter,
matchen den Namen aber nicht → `state.alwaysOnThinker` bleibt `false`, die ehrliche Notice
feuert nicht, und die Suppression-Lücke bleibt für den Nutzer unsichtbar.

**Soll:** **Laufzeit-Detektion** statt reiner Namensliste. Hat das Modell trotz angeforderter
Suppression (`thinking === 'off'`) tatsächlich gedacht, wird `alwaysOnThinker` gesetzt.

**Entscheidung (bestätigt):** Explizites **`reasoned: boolean`** auf `LlmStreamResult` (statt
`thinkTokens > 0`-Proxy) — sauberer Vertrag, unabhängig von der Token-Schätzung, direkt testbar.

**Fix:**
- `src/core/ports.ts` — `LlmStreamResult` bekommt `reasoned: boolean`.
- `src/core/local-llm-client.ts` — beide Pfade setzen `reasoned`:
  Streaming über `reasoningHappened(content, reasoningText)` (vendored, unverändert genutzt);
  Non-Streaming über die Reasoning-Komponente von `extractChatContent`.
- `src/core/orchestrator.ts` — nach jedem Stream-Ergebnis (Primär + Repair):
  `if (params.thinking === 'off' && result.reasoned) this.state.alwaysOnThinker = true;`
  Der Namens-Regex `isAlwaysOnThinker` **bleibt** als billiger Preflight-Hinweis (setzt das
  Flag schon vor dem ersten Call, wenn der Name bekannt ist).
- `src/i18n/strings.ts` — `notice.run.alwaysOnThinker` wird **modell-agnostisch** umformuliert
  (nennt nicht mehr hart „gpt-oss/harmony", da die Detektion jetzt laufzeit- und namensunabhängig ist),
  z. B. DE: *„Dieses Modell hat trotz ‚thinking: off' weitergedacht — die Unterdrückung greift nicht vollständig."*

**Kein vendored-Kit-Eingriff:** `reasoning.ts` wird nur *genutzt*, nicht verändert →
keine Kit-Promotion, kein Zwei-Repo-Release. `tests/vendor/kit.test.ts` bleibt gültig.

## Architektur-Invarianten

- `src/core/**` importiert weiterhin kein `obsidian` (CI-Gate `check:pure` bleibt grün).
  Alle Fixes leben in core/i18n; `extractErrorMessage` ist rein.
- `ErrorKind` bleibt Single-Source: Union in `types.ts` + Laufzeit-Liste `ERROR_KINDS` in
  `run-log.ts` müssen konsistent sein (bestehende Konvention).
- `LlmCallError.kind` bleibt unverändert (`overflow|timeout|stalled|http`) — der Split passiert
  erst im Orchestrator-Mapping (`http → endpoint_error`), nicht im Client-Vertrag.

## Tests (TDD — je Bug erst reproduzierender Fehltest)

- **D1:** `LlmCallError('…', 'http')` → `llmErrorKind` liefert `endpoint_error` (nicht
  `endpoint_unreachable`). `ERROR_KINDS` enthält `endpoint_error`. i18n-Key existiert de+en.
- **D2:** `extractErrorMessage({error:{message:'model not loaded'}})` → `'model not loaded'`;
  `{error:'bad request'}` → `'bad request'`; `{message:'…'}` → `'…'`; ohne Feld → `null`.
  Client-Integrationstest: 400 mit pretty-printed JSON-Body → Message ist einzeilig und
  enthält den Error-Text (nicht `{`).
- **D3:** `LlmStreamResult.reasoned` wird bei separatem reasoning-Feld / inline `<think>` `true`,
  sonst `false`. Orchestrator: `thinking:'off'` + `reasoned:true` → `result.alwaysOnThinker`
  `true`, obwohl der Modellname den Regex nicht matcht.

## Nicht in diesem Teilprojekt

- **Retry-Button** (P3) — Erholung nach `endpoint_error`/anderen Fehlern.
- **Live-Token-Streaming + Sidebar-Politur** (P2) — inkl. echtem Think-Ticker (der `token`-Event
  `isThink`-Pfad bleibt hier unangetastet; D3 nutzt nur das aggregierte `reasoned`-Signal).

## Release

Additive API (neue `ErrorKind`, neues optionales Verhalten) ohne Breaking Change. Patch oder
minor — Entscheidung beim `finishing-a-development-branch`. Standalone-Release gerechtfertigt,
da user-facing (ehrlichere Fehler) — kein Bündeln nötig, aber möglich.
