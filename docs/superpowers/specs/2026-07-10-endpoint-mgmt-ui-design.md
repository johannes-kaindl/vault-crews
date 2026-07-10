# Endpoint-Management-UI — Design

**Datum:** 2026-07-10 · **Branch:** `feat/endpoint-mgmt-ui` · **Status:** genehmigt (Brainstorming)

## Problem

Die Settings-UI für Endpunkte (`src/obsidian/settings.ts`, `renderConnection`) ist zu roh
zum Testen: zwei freie Textareas (Endpoints, Denied) und ein globaler „Test connection"-Button,
der die Liste der Reihe nach pingt und **eine** Notice zeigt. Kein Per-Zeile-Status, keine
Fehlerklassen, keine Eingabe-Warnungen, kein Modell-Picker. Das Nachbar-Plugin `vault-rag`
hat dafür längst einen Per-Zeile-Editor (`buildEndpointList`), gespeist aus vendorten
`obsidian-kit`-Modulen. Dieses Design übernimmt dieses Muster nach vault-crews.

## Scope

**In scope (Vollausbau, in EINER Richtung Kit→vault-crews):**
1. **Endpoints:** Per-Zeile-Editor mit Add/Remove, Live-Status-Icon je Zeile (loader→check/x),
   Eingabe-Warn-Icon, „+ Preset"-Buttons, Markierung des aktiven Endpoints.
2. **Denied endpoints:** derselbe Zeilen-Editor, aber **ohne** Test/Status/Presets/Active
   (Denied werden nie kontaktiert) — nur Add/Remove + Eingabe-Warnungen.
3. **Default model:** Dropdown, gefüllt aus `listModels()` des ersten erreichbaren Endpoints,
   mit **Freitext-Fallback** (offline oder gespeichertes Modell nicht in Liste → nie toter Zustand).

**Out of scope / Folge-Task (bewusst vertagt):**
- **Kit-Promotion vault-crews→Kit:** `src/core/model-info.ts` (Ollama-Kontextparser,
  `suppressParams`, `isAlwaysOnThinker`), CORS-Non-Stream-Fallback als `obsidian-kit`-Kandidaten
  + REGISTRY-Eintrag. vault-crews hat Ollama-Support, den das Kit noch nicht kennt — eigener
  beidseitiger Abgleich in einer Folge-Session.
- Kein persistenter „aktiver Endpoint"-Cache im Plugin. Der aktive wird weiter **pro Lauf**
  im Orchestrator via `resolveActiveEndpoint` aufgelöst; „aktiv" ist in den Settings ein reiner
  Anzeige-Zustand aus den Live-Probes.

## Architektur (Ansatz A: Pure Model + parametrisierter Render-Helfer)

```
Kit → vault-crews (vendoren)
  src/vendor/kit/endpoint_diagnostics.ts   NEU  verbatim aus obsidian-kit, Herkunfts-Header
  src/vendor/kit/endpoint.ts               UPD  auf Kit-Stand heben (+ parseEndpointList)
  tests/vendor/kit.test.ts                 UPD  Vertrags-Smoke (classify-Fälle, Presets, Warn-Rules)

Pure Logik (obsidian-frei, in check:pure aufgenommen — wie panel-view-model.ts)
  src/obsidian/endpoint-editor-model.ts    NEU
  tests/obsidian/endpoint-editor-model.test.ts  NEU (node-only)

Render + Verdrahtung (obsidian-Schicht)
  src/obsidian/settings.ts   UPD  buildListEditor(container, opts) ×2 + Modell-Feld
  src/main.ts                UPD  SettingsHost: probeEndpoint + loadModels (testConnection raus)
  src/i18n/strings.ts        UPD  neue DE/EN-Strings
  styles.css                 UPD  .vault-crews-ep-status/-ep-warn
  package.json               UPD  check:pure-Grep um endpoint-editor-model.ts erweitern
```

### Vendoring

- `endpoint_diagnostics.ts` **verbatim** aus `obsidian-kit/src/pure/endpoint_diagnostics.ts`,
  Header `// vendored from obsidian-kit#0.4.0, src/pure/endpoint_diagnostics.ts`.
  **Versions-Drift-Fund:** REGISTRY/Header-Folklore sagt `0.5.0`, aber `obsidian-kit/package.json`
  sagt `0.4.0` — der Header stempelt die **tatsächliche** Version (0.4.0).
- `endpoint.ts` auf den Kit-Stand (bringt `parseEndpointList`), Header `#0.4.0`.
- Exporte, die wir nutzen: `classifyEndpointStatus(ProbeInput): EndpointStatus`,
  `ENDPOINT_PRESETS: EndpointPreset[]` (LM Studio `:1234`, Ollama `:11434`),
  `validateEndpointInput(url): EndpointWarning[]`, `parseEndpointList(text): string[]`.

### Pure Model (`endpoint-editor-model.ts`)

Obsidian-frei, node-testbar. Enthält:
- `applyEndpointEdit(list: string[], index: number, value: string, isAdder: boolean): string[]`
  — trimmt; `isAdder` hängt an; leerer Wert entfernt den Index; filtert am Ende alle Leeren.
- `activeIndexFromStatuses(statuses: (EndpointStatusKind | null)[]): number`
  — Index der **ersten** Zeile mit `kind === "ok"`, sonst `-1`. Das ist exakt die
  `resolveActiveEndpoint`-Semantik (erster erreichbarer gewinnt), rein aus den Per-Zeile-Probes
  abgeleitet — kein separater Resolver-Call fürs Markieren nötig.
- `modelFieldMode(models: string[], saved: string): "dropdown" | "freetext"`
  — `"dropdown"` sobald `models.length > 0`; sonst `"freetext"`. **Korrektur (2026-07-10, aus
  Smoke-Fund):** die ursprüngliche Bedingung `saved === "" || models.includes(saved)` war
  falsch — ein gespeichertes Modell, das der aktive (erste erreichbare) Endpoint nicht listet
  (z.B. es liegt auf einem zweiten Endpoint), versteckte den Dropdown komplett, obwohl „Modelle
  laden" 11 Modelle geliefert hatte. Jetzt: Dropdown immer bei geladenen Modellen; die
  Render-Schicht bewahrt einen nicht-gelisteten `saved`-Wert als zusätzliche Option (nie
  verlieren, aber wählbar machen). Freetext ist nur noch der Offline-/Noch-nicht-geladen-Fall.
- `statusKindKey(kind: EndpointStatusKind): string` → i18n-Key (`settings.endpoint.status.<kind>`).
- `warnRuleKey(rule: string): string` → i18n-Key (`settings.endpoint.warn.<rule>`).

**i18n-Grenze:** Der Kit-Modul backt **deutsche** `klartext`/`message`-Strings. Damit EN nicht
leckt, mappt die pure Schicht `kind`/`rule` auf i18n-Keys; die Render-Schicht ruft `t(key)`.
Der deutsche `klartext`/`raw` dient nur als Roh-Fallback (kind `unknown`: `t(...unknown) + raw`).
Das vendored Modul bleibt dadurch **byte-identisch** zum Kit (saubere Vendoring-Hygiene).

### SettingsHost-Vertrag (`settings.ts`)

```ts
export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  probeEndpoint(endpoint: string): Promise<EndpointStatus>;              // ping+classify, EINE Zeile
  loadModels(): Promise<{ endpoint: string | null; models: string[] }>; // aktiven auflösen + listModels
}
```
Das grobe `testConnection(endpoint): Promise<{ok, models}>` **entfällt** (ersetzt).

### Probe-Pfad (`main.ts`)

Beide Host-Methoden bauen — wie das heutige `testConnection` — einen **frischen**
`LocalLlmClient` via `buildLlmClient()` + `setBase(normalizeEndpoint(ep))`, rühren `this.llm`
(den Lauf-Client) nie an → können nie mit einem laufenden Run racen.
- `probeEndpoint`: `client.ping()`, Erfolg/gefangenen Fehler/Timeout in ein `ProbeInput` fassen →
  `classifyEndpointStatus(...)`. Der Client muss die rohe Fehlermeldung durchreichen, damit die
  Regex-Klassifikation (`ECONNREFUSED`→refused etc.) greift.
- `loadModels`: `resolveActiveEndpoint(settings.endpoints, ep => client.ping(ep))`; bei Treffer
  `listModels()` auf diesem Endpoint, sonst `{ endpoint: null, models: [] }`.

## UI-Verhalten

### Zeilen-Editor `buildListEditor(container, opts)` (Endpoints + Denied)

- `rows = [...list, ""]` — die letzte Leerzeile **ist** der Adder (kein separater Add-Button;
  `isAdder = i >= list.length`). Label/Desc nur in Zeile 0.
- Jede Zeile ist ein `Setting` mit: (opt.) Status-Icon-Span, Text-Input, (nicht am Adder)
  Mülleimer-`addExtraButton`, (opt.) Warn-Icon.
- **Mutation nur bei `blur`, nicht `onChange`** (sonst hängt der Adder jeden Zwischenstand
  `h`,`ht`,… an): Listener auf `inputEl` `"blur"` → `applyEndpointEdit` → `saveSettings()` →
  `this.display()` (Full-Re-Render). Guard gegen No-Op-Re-Render bei unveränderter Liste.
- **Eingabe-Warnungen** (beide Listen): `validateEndpointInput(value)` synchron, nicht blockierend;
  bei Treffern `alert-triangle`-Icon, Tooltip = `t(warnRuleKey(rule))` je Regel. Blockiert nie
  das Speichern.
- **Endpoints-only:** pro echter Zeile async `host.probeEndpoint(ep)` → Icon `loader` →
  `circle-check`(`is-ok`)/`circle-x`(`is-error`), Tooltip = `t(statusKindKey(kind))`.
  Nach allen Probes markiert `activeIndexFromStatuses(...)` die aktive Zeile (`is-active` +
  Tooltip-Suffix „· aktiv"). Aktions-Zeile am Ende: ein `+ <Preset>`-Button je `ENDPOINT_PRESETS`
  (hängt `preset.url` an, wenn noch nicht vorhanden), plus „Verbindung prüfen" → `this.display()`
  (re-probt).
- **Denied-only:** kein Status, keine Presets, kein Active — nur Add/Remove + Warnungen.

### Default-model-Feld

- Zustand: die Tab-Instanz cached `{ models: string[] }` aus dem letzten `loadModels()`
  (initial leer → startet im Freitext-Modus; **kein** Auto-Netz-Hit beim Öffnen der Settings).
- `modelFieldMode(cachedModels, saved)`:
  - `"dropdown"` (Modelle geladen) → `addDropdown`, Optionen = geladene Modelle. Zusatz-Option:
    leere „— wählen —" wenn `saved===""`, ODER der gespeicherte Wert selbst, wenn er nicht in
    der Liste ist (bewahrt eine Auswahl auf einem anderen Endpoint). Auswahl setzt `defaultModel`.
  - `"freetext"` (keine Modelle geladen) → `addText` (heutiges Verhalten).
- **„Modelle laden"-Button** (immer sichtbar): `host.loadModels()` → cache setzen → `this.display()`.
  Zeigt bei `endpoint===null` eine kurze Notice („kein erreichbarer Endpunkt").

## i18n (neue Keys, EN kanonisch + DE)

- `settings.endpoint.status.{ok,refused,unknown-host,timeout,not-an-llm-api,unknown}`
- `settings.endpoint.warn.{scheme,malformed,port,placeholder-ip}`
- `settings.endpoint.active` („aktiv" / Suffix)
- `settings.connection.presetAdd` („+ {0}")
- `settings.connection.probe` („Verbindung prüfen" / „Check connection")
- `settings.connection.model.{load,none,placeholder,choose}` (Laden-Button, Kein-Endpunkt-Notice,
  Freitext-Hinweis, „— wählen —")
- Bereinigen: `settings.connection.testConnection.*` + `notice.testConnection.*` entfallen
  (globaler Test-Button weg → Per-Zeile).

## CSS (`styles.css`, vault-crews-namespaced, nur Theme-Variablen)

```
.vault-crews-ep-status { display:inline-flex; align-items:center; margin-right:8px;
  vertical-align:middle; color:var(--text-muted); }
.vault-crews-ep-status svg { width:14px; height:14px; }
.vault-crews-ep-status.is-ok    { color:var(--text-success); }
.vault-crews-ep-status.is-error { color:var(--text-error); }
.vault-crews-ep-status.is-active { font-weight:var(--font-bold); }
.vault-crews-ep-warn { display:inline-flex; align-items:center; margin-right:8px;
  vertical-align:middle; color:var(--text-warning); }
.vault-crews-ep-warn svg { width:14px; height:14px; }
```
A11y: Status via Form **und** Farbe **und** Tooltip-Text, nicht nur Farbe.

## Fehlerbehandlung

- Probe/loadModels fangen alle Fehler ab → nie ein Reject in die UI. `probeEndpoint`-Fehler
  werden klassifiziert; `loadModels`-Fehler → `{ endpoint:null, models:[] }`.
- Freitext-Fallback garantiert: das Modell-Feld ist nie ein toter Zustand (offline editierbar).
- Blur-Mutation + Re-Render-Guard verhindern Adder-Zwischenstände und unnötige Re-Renders.

## Testing (TDD, AGENTS.md: erst fehlschlagender Test; Gate = `npm run gate`)

- **Pure** `endpoint-editor-model.test.ts` (node-only): `applyEndpointEdit` (append/remove/edit/
  trim/filter-empties), `activeIndexFromStatuses` (erster ok / -1), `modelFieldMode`
  (dropdown/freetext-Grenzfälle), `statusKindKey`/`warnRuleKey` (Key-Mapping vollständig).
- **Vendor** `tests/vendor/kit.test.ts`: `classifyEndpointStatus` (200+`{data:[]}`→ok,
  ECONNREFUSED→refused, ENOTFOUND→unknown-host, timeout→timeout, 200-ohne-data→not-an-llm-api),
  `ENDPOINT_PRESETS` (2 Einträge), je eine `validateEndpointInput`-Regel, `parseEndpointList`.
- **Kein** DOM-Test für das Rendering (Logik ist pur); Render-Schicht bleibt dünn.
- **Manueller Smoke** (Release-Checklist): Settings öffnen → Endpoint tippen → Per-Zeile-Status;
  Preset hinzufügen; Denied add/remove; „Modelle laden" → Dropdown; offline → Freitext-Fallback.

## Definition of Done

- [ ] `endpoint_diagnostics.ts` + aktualisiertes `endpoint.ts` vendored, Vertrags-Smoke grün.
- [ ] `endpoint-editor-model.ts` pur (in `check:pure`), Tests grün.
- [ ] `settings.ts` rendert beide Zeilen-Editoren + Modell-Feld; `testConnection` entfernt.
- [ ] `main.ts` `probeEndpoint` + `loadModels` verdrahtet.
- [ ] i18n EN/DE ergänzt + tote Test-Keys entfernt; `styles.css` ergänzt.
- [ ] `npm run gate` grün (Exit-Code).
- [ ] Folge-Task „Kit-Promotion (model-info/suppressParams/CORS)" notiert.
