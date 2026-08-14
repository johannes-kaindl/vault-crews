# Live-Streaming-Sidebar (TP2, UX-Paket B+C)

**Datum:** 2026-07-12
**Status:** Design (approved)
**Kontext:** Roadmap UX-Paket. TP1 (P1-Robustheit) ist mit 0.7.0 released. Dies ist
TP2 (B+C: Live-Token-Streaming + professionellere Run-Sidebar). TP3 (Retry, A) folgt.

## Problem

Das Run-Panel zeigt während eines Laufs nur **Zähler** ("Streaming… 42 tokens",
"Thinking… 0 tokens"). Der eigentliche Token-**Text**, den das Modell produziert,
wird nie sichtbar — man sieht nicht, *was* die Crew gerade schreibt oder denkt. Zwei
konkrete Lücken im Code:

1. **`orchestrator.ts:433`** wirft den Token-String weg und emittiert hart
   `{ type: 'token', taskId, isThink: false }` — der Text erreicht das Panel nie, und
   `isThink` ist immer `false`.
2. **`local-llm-client.ts`** reicht via `onToken` nur **Content** durch. Reasoning-Tokens
   werden aus *zwei* Quellen nur akkumuliert, aber nie durchgereicht:
   - `<think>`-Tags im Content-Stream (getrennt vom `ThinkSplitter` → `parts.reasoning`)
   - das `reasoning_content`-SSE-Delta-Feld (`parsed.reasoning`)

   Folge: `thinkCount` im Panel ist strukturell immer 0.

Das ViewModel hat bereits `streamingText`/`thinkingText`-Felder (`panel-view-model.ts`),
aktuell aber nur mit Zähler-Strings gefüllt. Die Verkabelung für echten Live-Text fehlt
durchgängig.

## Ziel

Während eines Laufs zeigt die Sidebar den **Live-Token-Text** des aktuell laufenden
Tasks:

- **Content** als scrollbarer Live-Textbereich (voller Task-Output, reset pro Task).
- **Reasoning/Think** als Live-Text im bestehenden aufklappbaren `<details>`
  (zugeklappt per Default — „nie aufgedrängt", bestehendes Muster), plus Zähler in der
  Summary-Zeile.

Kein Verhaltenswechsel an Transport, Undo, Fehlerpfaden oder der Non-Streaming-Fallback-
Logik. Rein additive UX auf dem bestehenden Event-Strom.

## Nicht-Ziele (YAGNI)

- Kein Live-Ticker im **Non-Streaming-Fallback** (CORS/`OLLAMA_ORIGINS`-Fall): dort gibt
  es keinen Token-Stream. Verhalten bleibt wie heute dokumentiert (AGENTS.md: „kein
  Live-Token-Ticker im Non-Stream-Fallback").
- Kein Persistieren des Live-Textes (er lebt nur im laufenden RunningState; der dauerhafte
  Record bleibt `run.md`).
- Kein Markdown-Rendering des Live-Textes (Plaintext genügt; billiger und sicher).
- Kein Retry (das ist TP3).

## Architektur — die Kette

### 1. Client-Vertrag: `onToken` trägt `isThink`

`ports.ts` — `LlmClient.stream`:

```ts
// vorher
stream(messages, params, onToken: (t: string) => void, signal): Promise<LlmStreamResult>;
// nachher
stream(messages, params, onToken: (t: string, isThink: boolean) => void, signal): Promise<LlmStreamResult>;
```

Der zusätzliche Parameter ist **abwärtskompatibel**: bestehende Callbacks/Mocks, die nur
`(t)` deklarieren, bleiben typseitig zuweisbar (Funktion mit weniger Parametern → Ziel-Typ
mit mehr Parametern ist in TS erlaubt).

### 2. `local-llm-client.ts` reicht beide Quellen durch

Der `emit(piece)`-Helper (Content-Pfad über den `ThinkSplitter`) und die SSE-Schleife
(`reasoning_content`-Feld) rufen `onToken` mit dem passenden `isThink`-Flag:

- Content: `onToken(parts.content, false)` (bisher `onToken(parts.content)`)
- Reasoning aus `<think>`: `onToken(parts.reasoning, true)` (bisher nur akkumuliert)
- Reasoning aus `reasoning_content`: `onToken(r, true)` in der SSE-Schleife
- `flush()`-Tail entsprechend (`tail.content` → false, `tail.reasoning` → true)

Die interne Akkumulation (`content`, `reasoningText`) für `LlmStreamResult` bleibt
unverändert — `reasoned`/`thinkTokens` werden weiter aus ihr berechnet. Der
Non-Streaming-Pfad ruft `onToken` nicht (kein Stream).

### 3. `RunEvent.token` trägt den Text

`ports.ts`:

```ts
| { type: 'token'; taskId: string; isThink: boolean; text: string }
```

`orchestrator.ts` (die `stream`-Wrapper-Methode, aktuell Zeile ~431):

```ts
(text, isThink) => this.deps.reporter.emit({ type: 'token', taskId, isThink, text }),
```

### 4. State-Akkumulation (pure — TDD-Kern)

`panel-view-model.ts` — `RunningState` bekommt zwei Puffer:

```ts
streamText: string;   // voller Content-Output des laufenden Tasks
thinkText: string;    // voller Reasoning-Output des laufenden Tasks
```

`reduceRun`:

- `taskStarted`: `streamText = ""`, `thinkText = ""` (reset pro Task, analog zu
  `tokenCount`/`thinkCount`).
- `token`: `isThink ? thinkText += e.text : streamText += e.text`; Zähler wie bisher
  inkrementieren.
- **Sanity-Cap:** jeder Puffer wird auf `MAX_LIVE_CHARS` (~100 000) begrenzt (Tail
  behalten, vorne abschneiden) — reine Notbremse gegen Amoklauf-Modelle; „voller
  Task-Output" ist der Normalfall, der Cap greift praktisch nie.

Reset auch bei `runStarted` (Anfangszustand: beide `""`).

### 5. ViewModel: Text statt nur Zähler

`BodyVM.crewsRunning`:

```ts
| { kind: "crewsRunning";
    lines: { icon: string; label: string }[];
    streamText: string;      // NEU: voller Live-Content
    thinkText: string;       // NEU: voller Live-Think-Text
    streamEmptyText: string; // NEU: Platzhalter, solange streamText leer
    thinkingLabel: string;   // Zähler-Label fürs <details>-summary ("Thinking… N tokens")
  }
```

(Der bisherige Zähler-String `streamingText` entfällt zugunsten von `streamText` +
Platzhalter; `thinkingText` → `thinkingLabel`.)

### 6. Render + Performance: Token-Fast-Path

Heute macht `panel.ts#handleEvent` bei **jedem** Event `contentEl.empty()` + kompletten
Rebuild. Bei echtem Token-Text (hunderte Tokens/s) ist das DOM-Thrash und zerstört die
Scroll-Position. Lösung:

- **Voller Re-Render** für alle Nicht-`token`-Events (unverändertes „DOM = f(State)"-
  Prinzip). Er baut den Content-Live-Bereich (scrollbares `div`) + das `<details>` mit
  Think-Live-Text und befüllt beide aus dem VM-Text (korrekt auch nach Tab-Wechsel mitten
  im Lauf, weil der volle Text im State liegt).
- **Token-Fast-Path** in `handleEvent`: Ist `e.type === 'token'` **und** aktuell ein
  `crewsRunning`-Body im DOM, dann NICHT voll rendern, sondern:
  - `e.text` an den passenden Live-Text-Node anhängen (Content vs. Think),
  - das `thinkingLabel`/Content-Zähler-Element aktualisieren,
  - **Auto-Scroll nur, wenn der User bereits am unteren Rand ist** (Stick-to-bottom;
    reißt nicht runter, wenn man hochgescrollt mitliest).
  - Der Reducer wird trotzdem aufgerufen (State bleibt Wahrheit für den nächsten vollen
    Render); nur das Rendern wird auf das Delta verkürzt.

  Fällt der Fast-Path-Vorbedingung (kein crewsRunning-DOM vorhanden, z.B. gerade
  Tab „Verlauf" offen) → regulärer voller Re-Render.

Diese eine bewusste Abweichung vom „jedes Event rendert voll neu"-Prinzip ist durch
Performance + Scroll-Erhalt begründet und bleibt lokal auf den `token`-Fall beschränkt.

### 7. i18n

`src/i18n/strings.ts`:

- NEU `panel.streamEmpty`: „Warte auf Ausgabe…" / „Waiting for output…"
- `panel.thinking` bleibt (Zähler-Label „Thinking… {0} tokens").
- `panel.streaming` (Zähler) wird nicht mehr für den Hauptbereich gebraucht; bleibt
  vorerst als Key (kann später entfallen) oder wird zur optionalen Content-Zähler-Zeile.
  Entscheidung im Plan.

## Testbarkeit

- **Pure (RED-first, Kern):** `reduceRun` — Content/Think-Akkumulation getrennt nach
  `isThink`, Reset bei `taskStarted`/`runStarted`, Sanity-Cap (Tail-Behalten). Reine
  node-Tests ohne Mock. `buildPanelViewModel` — `crewsRunning` liefert Text + Platzhalter
  bei leer.
- **Client-Unit:** `local-llm-client` reicht Reasoning aus *beiden* Quellen mit
  `isThink=true` durch — Test gegen SSE-Fixtures mit `reasoning_content`-Deltas **und**
  mit `<think>…</think>` im Content-Stream. Content kommt mit `isThink=false`.
- **Integration (RED-first ordnen — offene Lesson 2026-07-12):** Orchestrator emittiert
  `token`-Events mit `text` + korrektem `isThink` end-to-end (Mock-LLM, das beide
  Token-Arten liefert). Der Integrationstest wird **vor** der Orchestrator-Verdrahtung
  geschrieben und ein **ausgeführter RED-Lauf** ist ein eigener Plan-Schritt.
- **DOM-Fast-Path:** dünn halten; ein gezielter Panel-Test, dass append + Zähler-Update
  ohne vollen Rebuild passiert und Auto-Scroll-Bedingung greift (soweit im Obsidian-Mock
  beobachtbar). Kein Deckungszwang auf DOM-Interna.

## Betroffene Dateien

- `src/core/ports.ts` — `onToken`-Signatur, `RunEvent.token.text`
- `src/core/local-llm-client.ts` — Reasoning-Durchreichung (beide Quellen)
- `src/core/orchestrator.ts` — `stream`-Wrapper reicht `(text, isThink)` durch
- `src/obsidian/panel-view-model.ts` — `RunningState`-Puffer, `reduceRun`, `crewsRunning`-VM
- `src/obsidian/panel.ts` — Live-Text-Render + Token-Fast-Path + Auto-Scroll
- `src/i18n/strings.ts` — `panel.streamEmpty`
- `styles.css` — Live-Text-Bereich (scrollbar, monospace/gedämpft, max-height)
- Mocks/Tests: `tests/core/orchestrator.test.ts`, `tests/helpers/script-llm.ts`,
  `tests/core/local-llm-client.test.ts`, `tests/obsidian/panel*.test.ts`

## Prozess

subagent-driven-development + finaler Opus-Whole-Branch-Review (wie 0.5.0–0.7.0). Gate
(`npm run gate`) grün vor jedem Commit. SDD-Plan ordnet Integrationstests **RED-first**
mit ausgeführtem RED-Schritt (Lesson 2026-07-12). Kit-Bezug: `parseSSE`/`ThinkSplitter`/
`reasoning.ts` sind bereits vendored und werden nur genutzt, nicht angefasst → kein
Kit-Eingriff, kein Zwei-Repo-Release.
