# Live-Streaming-Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Live-Token-Text (Content **und** Reasoning) des laufenden Tasks im Run-Panel sichtbar machen, statt nur Zähler.

**Architecture:** Token-Text durch die bestehende Event-Kette fädeln — `onToken(text, isThink)` im Client → `RunEvent.token.text` im Orchestrator → pure Reducer-Akkumulation im ViewModel → dünne Render-Schicht mit Token-Fast-Path (append statt full-rebuild) und Stick-to-bottom-Auto-Scroll. Rein additiv; kein Transport-/Undo-/Fehlerpfad-Wechsel.

**Tech Stack:** TypeScript, Obsidian-Plugin, Vitest (node-env, Obsidian-Mock via `resolve.alias`), esbuild. Vendored Kit-Module (`parseSSE`, `ThinkSplitter`, `reasoning.ts`) — nur genutzt, nicht angefasst.

## Global Constraints

- **Gate vor jedem Commit grün:** `npm run gate` (= lint + typecheck + test + check:pure). Exit-Code prüfen, nicht grep-Ausgabe.
- **Purität (check:pure):** `src/core/**`, `src/vendor/**` **und** `src/obsidian/panel-view-model.ts` importieren NIE `obsidian`. Der Reducer bleibt DOM-/obsidian-frei.
- **TDD RED-first:** erst fehlschlagender Test, dann Impl. Integrationstests werden **vor** der Verdrahtung geschrieben und ein **ausgeführter RED-Lauf** ist ein eigener Schritt (Lesson 2026-07-12).
- **Commit style:** Conventional Commits + Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Kein Kit-Eingriff:** `src/vendor/kit/**` bleibt unverändert.
- **i18n:** jeder neue Key in **EN** (`src/i18n/strings.ts` `EN`, ~Zeile 13) **und** **DE** (`DE`, ~Zeile 188).
- **DOM nur via createEl/createDiv/createSpan/setText/appendText** — nie HTML-String-Zuweisung.

---

### Task 1: Client reicht Reasoning-Tokens durch (`onToken(text, isThink)`)

**Files:**
- Modify: `src/core/ports.ts:41` (`LlmClient.stream`-Signatur)
- Modify: `src/core/local-llm-client.ts:75-190` (`emit`-Helper, SSE-Schleife, `flush`-Tail)
- Test: `tests/core/local-llm-client.test.ts`

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `LlmClient.stream(messages, params, onToken: (t: string, isThink: boolean) => void, signal)`. Content-Tokens kommen mit `isThink=false`, Reasoning-Tokens (aus `<think>`-Tags **und** aus dem `reasoning_content`-SSE-Feld) mit `isThink=true`.

- [ ] **Step 1: Write the failing test**

In `tests/core/local-llm-client.test.ts` neuen Test ergänzen (das SSE-Fixture-Muster der Datei nutzen — `postStream`-Transport, der `data:`-Zeilen einspeist). Der Test sammelt `(text, isThink)`-Paare:

```ts
it("routes content tokens as isThink=false and reasoning tokens as isThink=true", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" <think>inner</think> world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const sse = makeSseTransport(chunks, 200); // Fixture-Helfer der Datei
  const client = new LocalLlmClient("http://x:1234", sse, JSON_STUB, CLOCK, TIMEOUTS);
  const seen: Array<[string, boolean]> = [];
  await client.stream([{ role: "user", content: "q" }], PARAMS, (t, isThink) => seen.push([t, isThink]), new AbortController().signal);

  const think = seen.filter(([, k]) => k).map(([t]) => t).join("");
  const content = seen.filter(([, k]) => !k).map(([t]) => t).join("");
  expect(think).toContain("pondering");
  expect(think).toContain("inner");
  expect(content).toContain("Hello");
  expect(content).toContain("world");
  expect(content).not.toContain("inner"); // <think> gehört NICHT in Content
});
```

> Falls kein `makeSseTransport`-Helfer existiert, den in der Datei bereits verwendeten Fixture-Mechanismus wiederverwenden (die bestehenden Tests ab Zeile 76 zeigen das Muster). Nur die Signatur des `onToken`-Callbacks von `(t)` auf `(t, isThink)` heben.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/local-llm-client.test.ts -t "routes content tokens"`
Expected: FAIL — Reasoning-Tokens erreichen den Callback nicht (`think` ist leer), da `onToken` heute nur Content bekommt.

- [ ] **Step 3: Change the signature in ports.ts**

`src/core/ports.ts:41`:

```ts
	stream(messages: LlmMessage[], params: LlmParams, onToken: (t: string, isThink: boolean) => void, signal: AbortSignal): Promise<LlmStreamResult>;
```

- [ ] **Step 4: Route both reasoning sources through onToken**

`src/core/local-llm-client.ts` — `onToken`-Parametertyp (Zeile 78) und die drei Emit-Stellen:

Zeile 78:
```ts
		onToken: (t: string, isThink: boolean) => void,
```

`emit`-Helper (Zeile 117-124):
```ts
		const emit = (piece: string): void => {
			const parts = splitter.push(piece);
			if (parts.content !== '') {
				content += parts.content;
				onToken(parts.content, false);
			}
			if (parts.reasoning !== '') {
				reasoningText += parts.reasoning;
				onToken(parts.reasoning, true);
			}
		};
```

SSE-Schleife (Zeile 136-137):
```ts
						for (const delta of parsed.content) emit(delta);
						for (const r of parsed.reasoning) { reasoningText += r; onToken(r, true); }
```

`flush`-Tail (Zeile 164-169):
```ts
		const tail = splitter.flush();
		if (tail.content !== '') {
			content += tail.content;
			onToken(tail.content, false);
		}
		if (tail.reasoning !== '') {
			reasoningText += tail.reasoning;
			onToken(tail.reasoning, true);
		}
```

Der Non-Streaming-Pfad (`streamNonStreaming`) ruft `onToken` **nicht** — bleibt unverändert.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/local-llm-client.test.ts`
Expected: PASS (neuer Test + alle bestehenden — deren `(t) => …`-Callbacks bleiben zuweisbar).

- [ ] **Step 6: Gate + commit**

Run: `npm run gate`
Expected: exit 0.

```bash
git add src/core/ports.ts src/core/local-llm-client.ts tests/core/local-llm-client.test.ts
git commit -m "$(printf 'feat(llm): reasoning-Tokens durch onToken(text, isThink) durchreichen\n\nContent isThink=false, Reasoning aus <think> UND reasoning_content isThink=true.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Orchestrator fädelt Token-Text + isThink ins RunEvent (RED-first Integration)

**Files:**
- Modify: `src/core/ports.ts:92` (`RunEvent.token`)
- Modify: `src/core/orchestrator.ts:431-435` (`stream`-Wrapper)
- Modify: `tests/core/orchestrator.test.ts` (Mock-LLMs `stream`-Signatur + neuer Integrationstest)
- Modify: `tests/helpers/script-llm.ts:23` (Mock-Signatur)

**Interfaces:**
- Consumes: `onToken(text, isThink)` (Task 1).
- Produces: `RunEvent` mit `{ type: 'token'; taskId: string; isThink: boolean; text: string }`. Der Orchestrator emittiert pro Token-Callback ein solches Event mit dem echten Text und Flag.

- [ ] **Step 1: Add text to the RunEvent type**

`src/core/ports.ts:92`:
```ts
	| { type: 'token'; taskId: string; isThink: boolean; text: string }
```

- [ ] **Step 2: Update the LLM mocks to emit both token kinds**

`tests/core/orchestrator.test.ts` — beide Mock-`stream`-Methoden (Zeile 124, 136) auf die neue Signatur heben und mindestens einen Reasoning- + einen Content-Token liefern. Beispiel für den Mock ab Zeile 124:

```ts
  async stream(_m: LlmMessage[], _p: LlmParams, onToken: (t: string, isThink: boolean) => void): Promise<LlmStreamResult> {
    onToken("reasoning-bit", true);
    onToken(this.content, false);
    return { content: this.content, thinkTokens: 3, reasoned: true, finishReason: "stop" };
  }
```

Für den JSON-stückelnden Mock ab Zeile 136 die `onToken('{"it')`/`onToken('ems":')`-Aufrufe je um `, false` ergänzen.

`tests/helpers/script-llm.ts:23` analog: Parameter `onToken: (t: string, isThink: boolean) => void`; bestehende `onToken(...)`-Aufrufe um `, false` ergänzen.

- [ ] **Step 3: Write the failing integration test**

`tests/core/orchestrator.test.ts` — neuer Test, der den kompletten Lauf fährt und die emittierten `token`-Events prüft (das bestehende Reporter-Sammel-Muster der Datei nutzen — ein `RunReporter`, der `events.push(e)` macht):

```ts
it("emits token events carrying text and correct isThink end-to-end", async () => {
  const events: RunEvent[] = [];
  const reporter: RunReporter = { emit: (e) => events.push(e) };
  // ... Orchestrator mit dem content-liefernden Mock aus Step 2 aufsetzen (Muster der Datei) ...
  await orchestrator.run();

  const tokens = events.filter((e): e is Extract<RunEvent, { type: "token" }> => e.type === "token");
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.some((e) => e.isThink === true && e.text === "reasoning-bit")).toBe(true);
  expect(tokens.some((e) => e.isThink === false && e.text.length > 0)).toBe(true);
});
```

- [ ] **Step 4: Make it compile with a stub that still fails the assertion (real RED)**

Damit der Typ kompiliert, `src/core/orchestrator.ts:431-435` minimal so anpassen, dass `text` gesetzt ist, aber **noch nicht** aus dem Callback stammt — der Test muss inhaltlich failen (kein `"reasoning-bit"`, `isThink` immer false):

```ts
		return this.deps.llm.stream(
			messages, params,
			() => this.deps.reporter.emit({ type: 'token', taskId, isThink: false, text: '' }),
			this.deps.abort,
		);
```

- [ ] **Step 5: Run the integration test to verify it fails**

Run: `npx vitest run tests/core/orchestrator.test.ts -t "emits token events carrying text"`
Expected: FAIL — `text` ist `''` und `isThink` immer `false`; die `.some(... "reasoning-bit")`-Assertion schlägt fehl. Dies ist der ausgeführte RED-Beweis, dass der Test die Ziel-Behavior diskriminiert.

- [ ] **Step 6: Wire the real callback**

`src/core/orchestrator.ts:431-435`:

```ts
		return this.deps.llm.stream(
			messages, params,
			(text, isThink) => this.deps.reporter.emit({ type: 'token', taskId, isThink, text }),
			this.deps.abort,
		);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/core/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate + commit**

Run: `npm run gate`
Expected: exit 0.

```bash
git add src/core/ports.ts src/core/orchestrator.ts tests/core/orchestrator.test.ts tests/helpers/script-llm.ts
git commit -m "$(printf 'feat(orchestrator): Token-Text + isThink ins RunEvent faedeln\n\nRunEvent.token traegt jetzt text; stream-Wrapper reicht (text, isThink) durch\nstatt den String zu verwerfen. Integrationstest RED-first (ausgefuehrt).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Reducer akkumuliert Live-Text (pure)

**Files:**
- Modify: `src/obsidian/panel-view-model.ts` (`RunningState`, `reduceRun`, neue Konstante + Helfer)
- Test: `tests/obsidian/panel-view-model.test.ts`

**Interfaces:**
- Consumes: `RunEvent.token.text` (Task 2).
- Produces: `RunningState` mit `streamText: string` und `thinkText: string` (voller Task-Output, reset bei `taskStarted`/`runStarted`, Tail-gekappt auf `MAX_LIVE_CHARS`). `reduceRun` hängt `e.text` je nach `e.isThink` an den passenden Puffer an.

- [ ] **Step 1: Write the failing tests**

`tests/obsidian/panel-view-model.test.ts` — im `describe("reduceRun", …)`-Block. Der `applyEvents`-Helfer der Datei (Zeile 21) verkettet Events:

```ts
it("accumulates content into streamText and reasoning into thinkText, split by isThink", () => {
  const s = applyEvents([
    { type: "runStarted", runId: "r1", teamId: "t" },
    { type: "taskStarted", taskId: "a", index: 1, total: 1 },
    { type: "token", taskId: "a", isThink: false, text: "Hel" },
    { type: "token", taskId: "a", isThink: false, text: "lo" },
    { type: "token", taskId: "a", isThink: true, text: "hmm" },
  ]);
  expect(s.kind).toBe("running");
  if (s.kind !== "running") return;
  expect(s.streamText).toBe("Hello");
  expect(s.thinkText).toBe("hmm");
  expect(s.tokenCount).toBe(2);
  expect(s.thinkCount).toBe(1);
});

it("resets streamText and thinkText on taskStarted", () => {
  const s = applyEvents([
    { type: "runStarted", runId: "r1", teamId: "t" },
    { type: "taskStarted", taskId: "a", index: 1, total: 2 },
    { type: "token", taskId: "a", isThink: false, text: "first" },
    { type: "taskStarted", taskId: "b", index: 2, total: 2 },
  ]);
  if (s.kind !== "running") throw new Error("expected running");
  expect(s.streamText).toBe("");
  expect(s.thinkText).toBe("");
});

it("caps each live buffer to the last MAX_LIVE_CHARS characters", () => {
  const big = "x".repeat(MAX_LIVE_CHARS + 500);
  const s = applyEvents([
    { type: "runStarted", runId: "r1", teamId: "t" },
    { type: "taskStarted", taskId: "a", index: 1, total: 1 },
    { type: "token", taskId: "a", isThink: false, text: big },
  ]);
  if (s.kind !== "running") throw new Error("expected running");
  expect(s.streamText.length).toBe(MAX_LIVE_CHARS);
  expect(s.streamText.endsWith("x")).toBe(true);
});
```

`MAX_LIVE_CHARS` aus `panel-view-model.ts` importieren (Import-Zeile der Test-Datei um den Namen ergänzen).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/obsidian/panel-view-model.test.ts -t "accumulates content"`
Expected: FAIL — `streamText`/`thinkText`/`MAX_LIVE_CHARS` existieren nicht (Compile-/Assertion-Fehler).

- [ ] **Step 3: Add state fields, constant, and helper**

`src/obsidian/panel-view-model.ts`:

Konstante + Helfer (nahe dem Kopf, nach den Imports):
```ts
/** Notbremse gegen Amoklauf-Modelle: der Live-Text pro Task wird auf die letzten
 *  MAX_LIVE_CHARS Zeichen begrenzt (Tail behalten). „Voller Task-Output" ist der
 *  Normalfall; der Cap greift praktisch nie. */
export const MAX_LIVE_CHARS = 100_000;

function appendCapped(buf: string, add: string): string {
  const next = buf + add;
  return next.length > MAX_LIVE_CHARS ? next.slice(next.length - MAX_LIVE_CHARS) : next;
}
```

`RunningState` (nach `thinkCount: number;`):
```ts
  /** Voller Content-Output des laufenden Tasks (reset pro Task), Tail-gekappt. */
  streamText: string;
  /** Voller Reasoning-Output des laufenden Tasks (reset pro Task), Tail-gekappt. */
  thinkText: string;
```

- [ ] **Step 4: Wire reduceRun**

`runStarted`-Case (das zurückgegebene Objekt) um `streamText: "", thinkText: ""` ergänzen:
```ts
    case "runStarted":
      return {
        kind: "running", runId: e.runId, teamId: e.teamId,
        total: 0, index: 0, currentTaskId: null, lines: [],
        tokenCount: 0, thinkCount: 0, streamText: "", thinkText: "",
        writes: [], aborting: false,
      };
```

`taskStarted`-Case — nach `state.thinkCount = 0;`:
```ts
        state.streamText = "";
        state.thinkText = "";
```

`token`-Case ersetzen:
```ts
    case "token":
      if (state.kind === "running") {
        if (e.isThink) {
          state.thinkCount += 1;
          state.thinkText = appendCapped(state.thinkText, e.text);
        } else {
          state.tokenCount += 1;
          state.streamText = appendCapped(state.streamText, e.text);
        }
      }
      return state;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/obsidian/panel-view-model.test.ts`
Expected: PASS (neue + bestehende — bestehende `token`-Events in Zeile 113-114 brauchen jetzt `text`; falls der Typecheck dort meckert, `text: ""` ergänzen).

- [ ] **Step 6: Gate + commit**

Run: `npm run gate`

```bash
git add src/obsidian/panel-view-model.ts tests/obsidian/panel-view-model.test.ts
git commit -m "$(printf 'feat(panel): Reducer akkumuliert Live-Text (streamText/thinkText)\n\nVoller Task-Output pro Puffer, reset pro Task, Tail-Cap MAX_LIVE_CHARS.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: ViewModel liefert Live-Text statt Zähler-String

**Files:**
- Modify: `src/obsidian/panel-view-model.ts` (`BodyVM.crewsRunning`, `buildCrewsBody`)
- Modify: `src/i18n/strings.ts` (`panel.streamEmpty` in EN + DE)
- Test: `tests/obsidian/panel-view-model.test.ts`

**Interfaces:**
- Consumes: `RunningState.streamText`/`thinkText` (Task 3).
- Produces: `BodyVM.crewsRunning = { kind, lines, streamText, thinkText, streamEmptyText, thinkingLabel }`. `streamEmptyText` ist der Platzhalter, solange `streamText` leer ist; `thinkingLabel` ist das Zähler-Label fürs `<details>`-summary.

- [ ] **Step 1: Write the failing test**

`tests/obsidian/panel-view-model.test.ts` — im Crews-Body-Block (der bestehende Test „running body carries icon-prefixed task lines" ab Zeile 109 zeigt das Setup):

```ts
it("running body exposes live streamText/thinkText and an empty-placeholder", () => {
  const vmEmpty = buildPanelViewModel(inputsWith(applyEvents([
    { type: "runStarted", runId: "r1", teamId: "t" },
    { type: "taskStarted", taskId: "a", index: 1, total: 1 },
  ])));
  expect(vmEmpty.body.kind).toBe("crewsRunning");
  if (vmEmpty.body.kind !== "crewsRunning") return;
  expect(vmEmpty.body.streamText).toBe("");
  expect(vmEmpty.body.streamEmptyText.length).toBeGreaterThan(0);

  const vm = buildPanelViewModel(inputsWith(applyEvents([
    { type: "runStarted", runId: "r1", teamId: "t" },
    { type: "taskStarted", taskId: "a", index: 1, total: 1 },
    { type: "token", taskId: "a", isThink: false, text: "Hi" },
    { type: "token", taskId: "a", isThink: true, text: "mm" },
  ])));
  if (vm.body.kind !== "crewsRunning") throw new Error("expected crewsRunning");
  expect(vm.body.streamText).toBe("Hi");
  expect(vm.body.thinkText).toBe("mm");
  expect(vm.body.thinkingLabel).toContain("1"); // Zähler im Label
});
```

> `inputsWith(runState)` = kleiner Helfer, der `PanelInputs` mit `navState:"crews"`, leeren `teams`, `latest:null`, `nowMs:0` baut. Falls in der Datei schon ein solcher Helfer existiert, diesen nutzen; sonst lokal definieren.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/obsidian/panel-view-model.test.ts -t "live streamText"`
Expected: FAIL — `streamText`/`thinkText`/`streamEmptyText`/`thinkingLabel` fehlen im VM (heute nur `streamingText`/`thinkingText`).

- [ ] **Step 3: Add the i18n key (EN + DE)**

`src/i18n/strings.ts` — `EN` (nahe Zeile 149) und `DE` (nahe Zeile 321):

EN:
```ts
  "panel.streamEmpty": "Waiting for output…",
```
DE:
```ts
  "panel.streamEmpty": "Warte auf Ausgabe …",
```

- [ ] **Step 4: Update the BodyVM type and builder**

`src/obsidian/panel-view-model.ts` — `BodyVM`-Union, `crewsRunning`-Variante:
```ts
  | { kind: "crewsRunning"; lines: { icon: string; label: string }[]; streamText: string; thinkText: string; streamEmptyText: string; thinkingLabel: string }
```

`buildCrewsBody` — den `running`-Zweig ersetzen:
```ts
  if (runState.kind === "running") {
    return {
      kind: "crewsRunning",
      lines: runState.lines.map((l) => ({
        icon: TASK_ICON[l.status],
        label: `${l.taskId} — ${t(`panel.status.${l.status}`)}`,
      })),
      streamText: runState.streamText,
      thinkText: runState.thinkText,
      streamEmptyText: t("panel.streamEmpty"),
      thinkingLabel: t("panel.thinking", runState.thinkCount),
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/obsidian/panel-view-model.test.ts`
Expected: PASS. Falls der bestehende Test „running body carries … separate token/think counters" (ab Zeile 109) auf `streamingText`/`thinkingText` prüft, ihn auf `thinkingLabel` (Zähler) bzw. `streamText` umstellen.

- [ ] **Step 6: Gate + commit**

Run: `npm run gate`

```bash
git add src/obsidian/panel-view-model.ts src/i18n/strings.ts tests/obsidian/panel-view-model.test.ts
git commit -m "$(printf 'feat(panel): crewsRunning-VM liefert Live-Text + Platzhalter\n\nstreamText/thinkText/streamEmptyText/thinkingLabel statt Zaehler-Strings.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Panel rendert Live-Text mit Token-Fast-Path + Auto-Scroll

**Files:**
- Modify: `src/obsidian/panel.ts` (`RunPanelView`: Live-Node-Referenzen, `renderBody` crewsRunning, `handleEvent` Fast-Path)
- Modify: `styles.css` (Live-Text-Bereich)
- Modify: `tests/__mocks__/obsidian.ts` (nur falls `appendText`/`scrollTop`/`scrollHeight` im Mock fehlen)
- Test: `tests/obsidian/panel.test.ts`

**Interfaces:**
- Consumes: `BodyVM.crewsRunning` mit `streamText/thinkText/streamEmptyText/thinkingLabel` (Task 4).
- Produces: sichtbarer, scrollbarer Content-Live-Bereich + aufklappbares `<details>` mit Live-Think-Text. Token-Events patchen die Live-Nodes inkrementell (kein full rebuild) und scrollen mit, solange der Nutzer am unteren Rand ist.

- [ ] **Step 1: Write the failing test**

`tests/obsidian/panel.test.ts` — das bestehende Setup-Muster der Datei nutzen (View mit Fake-`PanelHost`, `handleEvent` treiben, `contentEl` inspizieren):

```ts
it("shows accumulated live content text while running", () => {
  const view = makeView(); // Muster der Datei
  view.handleEvent({ type: "runStarted", runId: "r1", teamId: "t" });
  view.handleEvent({ type: "taskStarted", taskId: "a", index: 1, total: 1 });
  view.handleEvent({ type: "token", taskId: "a", isThink: false, text: "Hello " });
  view.handleEvent({ type: "token", taskId: "a", isThink: false, text: "world" });

  const live = view.contentEl.querySelector(".vault-crews-live-content");
  expect(live?.textContent).toContain("Hello world");
});

it("shows a placeholder before the first content token", () => {
  const view = makeView();
  view.handleEvent({ type: "runStarted", runId: "r1", teamId: "t" });
  view.handleEvent({ type: "taskStarted", taskId: "a", index: 1, total: 1 });
  expect(view.contentEl.textContent).toContain("Waiting for output");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/obsidian/panel.test.ts -t "live content"`
Expected: FAIL — `.vault-crews-live-content` wird noch nicht gerendert.

- [ ] **Step 3: Add live-node references and reset them on every full render**

`src/obsidian/panel.ts` — Instanzfelder in `RunPanelView`:
```ts
  private liveContentEl: HTMLElement | null = null;
  private liveThinkEl: HTMLElement | null = null;
  private thinkSummaryEl: HTMLElement | null = null;
```

In `renderViewModel` ganz am Anfang (nach `root.empty()`), da ein voller Render die alten Nodes wegwirft:
```ts
    this.liveContentEl = null;
    this.liveThinkEl = null;
    this.thinkSummaryEl = null;
```

- [ ] **Step 4: Render the live areas in the crewsRunning branch**

`src/obsidian/panel.ts` — den `case "crewsRunning":` in `renderBody` ersetzen:
```ts
      case "crewsRunning": {
        const list = root.createDiv({ cls: "vault-crews-task-list" });
        for (const line of body.lines) {
          const row = list.createDiv({ cls: "vault-crews-task-row" });
          row.createSpan({ cls: "vault-crews-task-icon", text: line.icon });
          row.createSpan({ cls: "vault-crews-task-label", text: line.label });
        }
        // Content-Live-Bereich: Platzhalter solange leer, sonst scrollbarer Text.
        if (body.streamText === "") {
          root.createDiv({ cls: "vault-crews-live-empty", text: body.streamEmptyText });
        } else {
          this.liveContentEl = root.createDiv({ cls: "vault-crews-live-content", text: body.streamText });
        }
        // <think> aufklappbar (zu per Default). Live-Think-Node nur wenn Text da ist.
        const think = root.createEl("details", { cls: "vault-crews-think" });
        this.thinkSummaryEl = think.createEl("summary", { text: body.thinkingLabel });
        if (body.thinkText !== "") {
          this.liveThinkEl = think.createDiv({ cls: "vault-crews-live-think", text: body.thinkText });
        }
        return;
      }
```

- [ ] **Step 5: Run the render tests to verify they pass**

Run: `npx vitest run tests/obsidian/panel.test.ts -t "live content"` und `-t "placeholder"`
Expected: PASS. (Der Content-Test läuft aktuell über volle Re-Renders — der Fast-Path kommt als Nächstes und darf ihn nicht brechen.)

- [ ] **Step 6: Add the token fast-path to handleEvent**

`src/obsidian/panel.ts` — `handleEvent` ersetzen und Helfer ergänzen:
```ts
  handleEvent(e: RunEvent): void {
    this.runState = reduceRun(this.runState, e);
    if (e.type === "token" && this.tryFastPathToken(e)) return;
    this.render();
  }

  /** Hängt ein Token an den passenden Live-Node an, ohne das Panel neu zu bauen.
   *  Voraussetzung: der crewsRunning-Body ist gerade gerendert (Node vorhanden).
   *  Der erste Token eines Puffers (Node noch null → Übergang Platzhalter→Text bzw.
   *  Think-Node fehlt) fällt bewusst auf den vollen Render zurück. */
  private tryFastPathToken(e: Extract<RunEvent, { type: "token" }>): boolean {
    if (this.navState !== "crews" || this.runState.kind !== "running") return false;
    if (e.isThink) {
      if (this.liveThinkEl === null || this.thinkSummaryEl === null) return false;
      this.appendLive(this.liveThinkEl, e.text);
      this.thinkSummaryEl.setText(t("panel.thinking", this.runState.thinkCount));
      return true;
    }
    if (this.liveContentEl === null) return false;
    this.appendLive(this.liveContentEl, e.text);
    return true;
  }

  /** Append + Stick-to-bottom: nur mitscrollen, wenn der Nutzer schon (nahe) am
   *  unteren Rand ist — reißt nicht runter, wenn man hochgescrollt mitliest. */
  private appendLive(el: HTMLElement, text: string): void {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    el.appendText(text);
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }
```

- [ ] **Step 7: Write a fast-path test and run it**

`tests/obsidian/panel.test.ts`:
```ts
it("appends think tokens into the details and updates the counter without losing content", () => {
  const view = makeView();
  view.handleEvent({ type: "runStarted", runId: "r1", teamId: "t" });
  view.handleEvent({ type: "taskStarted", taskId: "a", index: 1, total: 1 });
  view.handleEvent({ type: "token", taskId: "a", isThink: false, text: "body" });
  view.handleEvent({ type: "token", taskId: "a", isThink: true, text: "th1" });
  view.handleEvent({ type: "token", taskId: "a", isThink: true, text: "th2" });

  expect(view.contentEl.querySelector(".vault-crews-live-content")?.textContent).toContain("body");
  expect(view.contentEl.querySelector(".vault-crews-live-think")?.textContent).toContain("th1th2");
  expect(view.contentEl.querySelector(".vault-crews-think summary")?.textContent).toContain("2");
});
```

Run: `npx vitest run tests/obsidian/panel.test.ts`
Expected: PASS. Falls `appendText` oder `scrollTop`/`scrollHeight`/`clientHeight` im Obsidian-Mock (`tests/__mocks__/obsidian.ts`) fehlen, minimal ergänzen: `appendText(s)` hängt einen TextNode an bzw. `this.textContent += s`; die Scroll-Properties als `0`-Defaults.

- [ ] **Step 8: Add styles**

`styles.css` — nach dem `.vault-crews-think summary`-Block:
```css
.vault-crews-live-content,
.vault-crews-live-think {
  margin-top: var(--size-4-2);
  padding: var(--size-4-2);
  max-height: 40vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-monospace);
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
}
.vault-crews-live-empty {
  margin-top: var(--size-4-2);
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
}
```

- [ ] **Step 9: Gate + commit**

Run: `npm run gate`
Expected: exit 0.

```bash
git add src/obsidian/panel.ts styles.css tests/obsidian/panel.test.ts tests/__mocks__/obsidian.ts
git commit -m "$(printf 'feat(panel): Live-Text-Render mit Token-Fast-Path und Auto-Scroll\n\nScrollbarer Content-Bereich + aufklappbarer Think-Bereich; token-Events\npatchen die Live-Nodes inkrementell (kein full rebuild), Stick-to-bottom.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: CHANGELOG + Whole-Branch-Review-Vorbereitung

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:** keine.

- [ ] **Step 1: Add the changelog entry**

`CHANGELOG.md` unter `[Unreleased]` (bestehendes Format der Datei spiegeln):
```markdown
### Added
- Live-Token-Streaming im Run-Panel: der Content- und Reasoning-Text des laufenden Tasks
  wird live angezeigt (Content scrollbar, Reasoning aufklappbar), statt nur Zähler.
  Reasoning-Tokens werden jetzt real erfasst (`thinkCount`).
```

- [ ] **Step 2: Gate + commit**

Run: `npm run gate`

```bash
git add CHANGELOG.md
git commit -m "$(printf 'docs(changelog): Live-Token-Streaming im Run-Panel\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 3: Whole-Branch-Review**

Nach Abschluss aller Tasks: `superpowers:requesting-code-review` (Opus, Whole-Branch) gegen `main` — wie bei 0.5.0–0.7.0. Findings triagieren, dann Merge-Entscheidung via `superpowers:finishing-a-development-branch`. Anschließend **gezielter Smoke** (via user-handover, Jay): Crew mit einem streamenden Modell laufen lassen, prüfen dass Content live erscheint und der Think-Bereich sich füllt.

---

## Self-Review

**Spec coverage:**
- onToken(text, isThink) + Reasoning aus beiden Quellen → Task 1 ✓
- RunEvent.token.text + Orchestrator-Verdrahtung → Task 2 ✓
- Reducer-Akkumulation, Reset pro Task, Sanity-Cap → Task 3 ✓
- crewsRunning-VM (Text + Platzhalter + Zähler-Label) → Task 4 ✓
- Panel-Render + Token-Fast-Path + Auto-Scroll + CSS → Task 5 ✓
- Non-Streaming ohne Live-Ticker (Nicht-Ziel) → nicht angefasst (Task 1 Step 4 explizit) ✓
- i18n EN+DE → Task 4 Step 3 ✓
- CHANGELOG + Review + Smoke → Task 6 ✓

**Placeholder scan:** Kein TBD/TODO. Jeder Code-Step zeigt konkreten Code. Die zwei Test-Helfer-Verweise (`makeSseTransport`, `inputsWith`, `makeView`) sind explizit als „Muster der Datei nutzen, sonst lokal definieren" markiert, weil ihre exakte Form aus dem bestehenden Test-Setup stammt.

**Type consistency:** `streamText`/`thinkText` (State) → `streamText`/`thinkText`/`streamEmptyText`/`thinkingLabel` (VM crewsRunning) → gleiche Namen in Task 5 render + Fast-Path. `MAX_LIVE_CHARS`/`appendCapped` konsistent. `onToken: (t: string, isThink: boolean) => void` in ports.ts, local-llm-client, orchestrator-Wrapper, allen Mocks. `RunEvent.token` = `{ type, taskId, isThink, text }` durchgängig.
