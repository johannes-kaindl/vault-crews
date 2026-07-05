# Design: Run-Panel-UI-Überarbeitung

**Feature:** `feat/run-panel-ui` · **Betrifft:** `src/obsidian/panel.ts` (+ neue
`panel-view-model.ts`), `styles.css`, i18n-Strings, AGENTS.md/README-Limitationstexte.
**Verbindliches Regelwerk:** `../UI-STANDARD.md` (obsidian-plugins-Dach, ab 2026-07-05).

**Ausgangslage:** V1-core ist nach `main` gemergt. Das Run-Panel (`RunPanelView`, 270 Z.)
hat einen sauberen `idle → running → done`-Automaten, surface aber genau **eine** Funktion
(Crews laufen lassen). Weitere existierende Funktionen — **Undo last run**, **Open last run
log**, **Install example crews** — leben nur als Command oder als transienter Done-State und
sind nach Panel-Neuöffnung nicht mehr erreichbar. `styles.css` ist leer (0 Z.). Der Abbruch
ist als V1-Limitation dokumentiert: kurze Läufe (1–2 s, MoE-Modell) schließen, bevor der Klick
das Stream-Fenster trifft → Lauf endet `ok` statt `aborted`, das Panel bleibt bei „Wird
abgebrochen …" hängen.

**Ziel dieses Branches:** Politur **+** interne Hub-Navigation. Die §4-Blaupause des
UI-STANDARD (Kopf + Tab-Navigation + Content + optionale Statuszeile) wird am `RunPanelView`
real gebaut — die scattered Funktionen bekommen ein persistentes Zuhause, die Abbruch-UX wird
ehrlich, `styles.css` wird nach §3 befüllt.

**Leitentscheidung Abbruch:** Der Abbruch-*Mechanismus* ist bereits korrekt (kooperativ:
Orchestrator prüft `abort.aborted` an jeder Task-Grenze **und** im LLM-Stream). Die einzige
Lücke ist ein einzelner kurzer Task ohne weiteren Checkpoint nach Stream-Ende — das ist
*korrektes* Verhalten (die Arbeit war fertig). Es wird daher **kein neuer Mechanismus** gebaut;
stattdessen werden die Panel-States wahrhaftig, sodass die Limitation vom *Bug* zum erklärten
Verhalten wird.

---

## 1 · Layout: der eine View, §4-Blaupause

```
┌─────────────────────────────────────┐
│  Vault Crews                         │  ← Kopf (Titel)
│  [ Crews ]  [ Verlauf ]              │  ← Tab-Leiste (Segment-Navigation)
├─────────────────────────────────────┤
│                                     │
│   … Inhalt des aktiven Tabs …       │  ← Content-Container (genau eine Funktion)
│                                     │
├─────────────────────────────────────┤
│  ▶ läuft 2/3 · Daily-Briefing  [✕]  │  ← Statuszeile: NUR bei aktivem Lauf
└─────────────────────────────────────┘
```

- **Crews-Tab**
  - `idle` → Team-Liste mit Run-Buttons. Leere Liste → Empty-State mit
    **„Install example crews"**-Button (bislang nur Command).
  - `running` → Fortschrittsansicht: Task-Zeilen (Icon-Vokabular wie heute), Token-Zähler,
    natives `<details>` für den `<think>`-Zähler. **Reine Anzeige — kein Abbrechen-Button hier.**
  - `done` → Ergebnis-Karte (`renderRunSummary`, siehe §4) + **„Zurück zur Übersicht"**
    (setzt `runState` zurück auf `idle`).
- **Verlauf-Tab** — immer der persistente Verlauf (§4), unabhängig vom `runState`.
- **Statuszeile** — nur sichtbar, *während* ein Lauf läuft. Trägt den **einzigen**
  Abbrechen-Button (Spec §6.2 „genau ein Cancel"). Dadurch aus jedem Tab erreichbar; die
  Fortschrittsansicht im Crews-Tab bleibt buttonfrei.

**Ausnahme-Notiz (UI-STANDARD §1):** nicht nötig — es bleibt bei genau einem `registerView`
(`VIEW_TYPE_CREWS`).

---

## 2 · State-Modell: zwei orthogonale Achsen

Heute vermischt `panel.ts` Zustand und Render-Entscheidungen. Neu getrennt:

- **`navState`**: `"crews" | "verlauf"` — welcher Tab aktiv ist. Wird **in der View gehalten**,
  überlebt Re-Render (§4-Invariante „Navigationszustand überlebt Re-Render"), wird **nie** aus
  dem DOM rekonstruiert. Default `"crews"`; ein Panel-Neuöffnen (frische View) startet bei
  `"crews"`.
- **`runState`**: `idle | running | done` — wie heute ausschließlich aus Orchestrator-Events
  (`handleEvent`) getrieben.

Beide Achsen sind unabhängig. Startet ein Lauf, während `navState === "verlauf"`, aktualisiert
`runState` weiter; ein Wechsel nach `"crews"` zeigt via reiner `State → DOM`-Funktion den
aktuellen Fortschritt. Kein Auto-Tab-Wechsel bei Lauf-Ende (bewusst — ein erzwungener
Kontextwechsel ist störend).

**Erweiterung `DoneState`:** bekommt ein Feld `abortRequested: boolean`, übernommen aus
`RunningState.aborting` beim `runFinished`-Übergang. Nur so kann die Ergebnis-Karte den
ehrlichen Abbruch-Text bilden (§3).

```ts
type NavState = "crews" | "verlauf";
type RunState = { kind: "idle" } | RunningState | DoneState;
interface DoneState { kind: "done"; result: RunResult; abortRequested: boolean; }
// RunningState unverändert (behält `aborting`).
```

---

## 3 · Abbruch — ehrlich statt versprechend

Mechanismus unverändert. Nur Texte/States werden wahrhaftig:

- **Während Lauf, nach Klick:** Statuszeile → **„⏳ Abbruch angefordert …"** (nicht „wird
  abgebrochen" — es *kann* noch regulär fertig werden). `aborting`-Flag wie heute; es
  deaktiviert den Abbrechen-Button und verhindert Mehrfach-Abbruch.
- **Bei `runFinished`** unterscheidet die Ergebnis-Karte über `result.status` + `abortRequested`:
  - `status === "aborted"` → „Abgebrochen — N Dateien vor dem Abbruch geschrieben."
  - `abortRequested && status === "ok"` → **„Lauf war schon fertig, bevor der Abbruch griff —
    nichts abgebrochen."**
  - sonst → bestehende Done-Texte.
- **Folge-Doku:** die Abbruch-Limitation in `AGENTS.md` (V1 limitations) und `README.md` wird
  entschärft — vom „best-effort, kann verpuffen"-Bug zum erklärten kooperativen Verhalten mit
  ehrlichem UI-Feedback.

Die Abbruch-Ehrlichkeit ist reine ViewModel-Logik (`RunState → Texte`) und damit node-testbar
(§5), ohne echten LLM-Lauf.

---

## 4 · Verlauf-Tab

Fakt aus dem Code: **Undo** und **Log öffnen** operieren beide auf `mostRecentRun()` — dem
global jüngsten Lauf (git-`revert` kann nur den HEAD-Commit sauber zurückdrehen). Pro Crew
existiert ein `lastRuns[teamId]`-Eintrag, aber die Aktionen gelten nur dem allerneuesten.

- **Oben — jüngster Lauf als persistente Ergebnis-Karte:** Crew · Status · Datei-*Zahl*
  · Commit · Dauer, mit Aktionen **„Log öffnen"** + **„Undo"**. Nutzt *dieselbe*
  `renderSummary`-Komponente wie die Crews-Done-Karte (DRY, ein Testziel). Die
  einzelnen Datei-*Links* bleiben der Live-Done-Karte vorbehalten (sie hält die Pfade
  in-memory aus `actionApplied`); die persistente Karte zeigt nur die Zahl + „Log öffnen"
  — die Pfade zu persistieren wäre für den Verlauf unnötiger Ballast (YAGNI).
- **Darunter — Per-Crew-Statusliste:** je Crew letzter Status + „vor X" (Relativzeit).
  **Rein informativ, keine Aktionsbuttons** — Klick auf eine Zeile öffnet deren `run.md`.
  Ehrlich, weil Undo mechanisch nur den HEAD-Lauf kann.
- **Leerer Verlauf** (noch kein Lauf) → dezenter Empty-State-Text.

Der Verlauf-Tab liest ausschließlich über den `PanelHost`-Vertrag (siehe §6) — keine
direkten Plugin-/Port-Zugriffe.

---

## 5 · Dateistruktur, CSS, Tests

**Split** (der 270-Zeiler wächst mit Tabs + Statuszeile + ViewModel sonst zu stark —
UI-STANDARD §6 „ViewModel als pure Funktion neben der View"):

- `src/obsidian/panel-view-model.ts` — **pure** `buildPanelViewModel(navState, runState,
  hostData, nowMs) → PanelViewModel`. **Kein `obsidian`-Import, kein DOM.** Hält Typen
  (`NavState`, `RunState`, `PanelViewModel`) und alle Entscheidungslogik: welche Tabs aktiv,
  welcher Body-Typ, Abbruch-Texte, Relativzeit, Verlauf-Zusammenbau. Node-testbar ohne Mock.
- `src/obsidian/panel.ts` — dünner `ItemView`: hält `navState` + `runState` + `runWrites`,
  ruft `handleEvent`, baut das ViewModel und rendert es via `createEl`/`createDiv` — **keine
  Entscheidungslogik im Render**.

**`styles.css`** (heute 0 Z.): nach UI-STANDARD §3 befüllen.
- **Präfix bleibt das bestehende `vault-crews-`** — kein zweites `vc-` einführen (ein Präfix
  pro Plugin). Bestehende Klassen (`vault-crews-team-list` etc.) bleiben; neue Klassen für
  Tab-Leiste, Statuszeile, Karten, Verlaufsliste tragen dasselbe Präfix.
- Nur Obsidian-Theme-Variablen (Katalog aus §3), **kein** `!important`, keine hardcodierten
  Farben/Fonts.
- Layoutmuster: flex + gap statt Margin-Stacking; Tab-Leiste als Segment; Statuszeile am
  Panel-Boden abgesetzt (`--background-secondary` + Border-Top).

**Tests (TDD, erst rot):** ViewModel als pure Funktion —
- Tab-Wechsel hält `navState` über Re-Render.
- Abbruch-Ehrlichkeit: `aborting + ok` → „schon fertig"-Text; `aborted` → Abbruch-Text.
- Verlauf-Zusammenbau: jüngster Lauf korrekt selektiert; Per-Crew-Liste sortiert; leerer
  Verlauf → Empty-State.
- Empty-State Crews (keine Teams) → Install-Button-Body.
Render bleibt dünn und ungetestet.

**Gate:** `npm run gate` (lint + typecheck + test + check:pure) muss grün sein; `panel-view-
model.ts` importiert nie `obsidian` (fällt sonst bei check:pure auf, obwohl es unter
`src/obsidian/` liegt — der pure-Check greift für `core/`+`vendor/`; hier ist es
Selbstdisziplin für die Node-Testbarkeit, nicht CI-erzwungen).

---

## 6 · `PanelHost`-Vertrag (Erweiterung)

Der bestehende Vertrag hat fünf `void`-Methoden (`getTeams`, `runCrew`, `abortCurrentRun`,
`undoLastRun`, `openLog`). Neu benötigt der Verlauf-Tab:

- **`installExamples(): void`** — für den Empty-State-Button (bisher nur Command).
- **`getLastRunSummary(): RunSummary | null`** — der global jüngste Lauf als anzeigefertiges
  ViewModel-Futter (Crew-Name, Status, `runId`, `commitSha`, `when`, Dateien). Entkoppelt die
  View von `lastRuns`/`mostRecentRun`-Interna.
- **`openRunLog(runId: string): void`** — Klick auf eine Per-Crew-Zeile öffnet gezielt deren
  `run.md` (Verallgemeinerung des bestehenden `openLog`, das implizit den jüngsten nimmt).

Alle neuen Methoden bleiben `void` bzw. reine Getter (kein Rückkanal in die Laufsteuerung);
`main.ts` implementiert sie über bereits vorhandene Bausteine (`installExamples`,
`mostRecentRun`, `openLastRunLog`).

---

## Bewusst außerhalb des Scopes (YAGNI)

- Kein Auto-Tab-Wechsel bei Lauf-Ende (störender Kontextwechsel).
- Keine Per-Crew-Undo-Buttons (Undo kann mechanisch nur den HEAD-Lauf).
- Keine Sprungnavigation an die Fehlerstelle im Log (bleibt V1.1).
- Kein neuer Abbruch-*Mechanismus* (Pre-Commit-Checkpoint o. Ä.) — kooperativ + ehrlich genügt.
- Keine Kit-Extraktion — der UI-STANDARD ist ein Regelwerk, kein geteilter Code (Pilot bleibt
  vault-crews).
