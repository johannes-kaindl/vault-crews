# Vault Crews V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Ausführungs-Kontext dieses Plans:** Wird inline (Hauptsession, voller Repo-Kontext) implementiert,
> da Subagenten-Kapazität limitiert ist. Task-Blöcke sind deshalb vertrags- statt codezeilen-granular;
> der VERBINDLICHE Detailgrad kommt aus drei Quellen, die vor jedem Task zu lesen sind:
> 1. Spec: `../specs/2026-07-02-vault-crews-design.md` (referenzierte §§)
> 2. Interface-Skelett: `2026-07-02-vault-crews-v1-interfaces.md` (exakte Pfade/Typen/Signaturen — bindend)
> 3. Detail-Anhänge (voll ausgearbeitete Task-Texte): `details/tasks-09-11-executor-gitplan-runlog.md`,
>    `details/tasks-14-15-gitport-adapter.md`

**Goal:** Obsidian-Plugin, das autonome lokale LLM-Agenten-Teams (LM Studio) deterministisch orchestriert: V1 = zwei Beispiel-Crews (Task-Triage, Daily-Briefing), manueller Trigger, direktes Schreiben mit Git-Commit pro Lauf.

**Architecture:** Pure-Core (`src/core/`, obsidian-frei, Ports-injiziert) + dünne Obsidian-Schicht (`src/obsidian/`). LLM nur als eingezäunter Daten-Transformator (collector → llm → actions), constrain-then-verify vor jedem Write, Partial-Commit-Semantik.

**Tech Stack:** TypeScript strict, esbuild (cjs, main.js), Vitest (node-env, Obsidian-Mock via alias), vendored obsidian-kit-Module, System-git via child_process, LM Studio OpenAI-API.

## Global Constraints

- `manifest.json`: `id: vault-crews`, `isDesktopOnly: true`, `minAppVersion: 1.7.2`. Lizenz AGPL-3.0.
- `src/core/**` und `src/vendor/**` importieren NIE `obsidian` (CI-Gate `check:pure`).
- KEINE `git+https`-npm-Dependencies (LESSONS.md 2026-07-01) — Kit-Module vendoren, Herkunfts-Header Pflicht.
- Netz: nie globales `fetch`; `requestUrl` (non-stream) / `XMLHttpRequest`+`onprogress` (stream), Transport injiziert.
- Default-Endpoint `http://localhost:1234/v1`; `:8080` auf Default-Denylist (OpenClaw-Mono-Consumer).
- Kein `json_schema`-API-Modus; prompt-basiertes JSON + Validierung (LM-Studio-Reasoning-Gotcha).
- UI-Strings nur via `t(...)`, EN+DE; sentence-case (obsidianmd-Lint).
- Vor jedem Commit grün: `npm run lint && npm run typecheck && npm test` (+ `check:pure`).
- Commits: `feat:`/`test:`/`chore:`/`docs:`-Prefix + Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TDD: pro Verhalten erst fehlschlagender Test (`npx vitest run <datei> --reporter=basic`), dann Minimal-Implementierung, dann PASS-Nachweis.

---

## Phase A — Fundament

### Task 1: Scaffold aus Template + CI-Gate
**Files:** Create: komplettes Scaffold aus `/Users/Shared/code/_docs/templates/obsidian-plugin/` (esbuild.config.mjs, eslint.config.mjs, tsconfig.json, tsconfig.test.json, vitest.config.ts, package.json, manifest.json, versions.json, scripts/, tests/) → angepasst auf `vault-crews`.
- [ ] Template kopieren; `manifest.json` (id/name/desc/isDesktopOnly), `package.json` (name, scripts) anpassen.
- [ ] `check:pure`-Skript ergänzen: `grep -rl "from 'obsidian'" src/core src/vendor && exit 1 || exit 0`; in `gate`-Skript integrieren (lint+typecheck+test+check:pure).
- [ ] `.nvmrc` mit aktueller Dev-Node-Major committen (LESSONS 2026-06-30: Lockfile↔CI-npm-Major-Pin).
- [ ] `npm install && npm run gate` grün → Commit `chore: scaffold vault-crews from obsidian-plugin template`.

### Task 2: Kit-Module + Obsidian-Mock vendoren
**Files:** Create: `src/vendor/kit/{sse,think,endpoint,i18n}.ts`, `tests/__mocks__/obsidian.ts` — Quellen: `/Users/Shared/code/obsidian-kit/src/pure/*` und `src/testing/obsidian-mock.ts` (reale Dateinamen dort prüfen und mappen).
- [ ] Jede Datei: erste Zeile `// vendored from obsidian-kit#0.2.0, <quellpfad>`; vitest-alias `obsidian` → Mock.
- [ ] Smoke-Tests: `parseSSE` zerlegt einen 2-Delta-SSE-String; `ThinkSplitter` trennt `<think>a</think>b`; `normalizeEndpoint('localhost:1234')` → `http://localhost:1234`; `resolveActiveEndpoint` wählt ersten pingbaren.
- [ ] Commit `chore: vendor obsidian-kit modules (sse, think, endpoint, i18n) + test mock`.

### Task 3: Typen, Ports, paths.ts, Test-Helper
**Files:** Create: `src/core/types.ts`, `src/core/ports.ts`, `src/core/paths.ts`, `tests/helpers/{in-memory-vault,fake-clock,recorder-git,recorder-reporter,script-llm}.ts`; Test: `tests/core/paths.test.ts`.
**Interfaces:** Produces = ALLES aus dem Skelett, wörtlich.
- [ ] types.ts/ports.ts 1:1 aus Skelett übernehmen (kompilierbar, keine Logik).
- [ ] paths.ts testgetrieben: `normalizeVaultPath` (trim, `\`→`/`, führende `/` weg, wirft bei `..`-Segment); `globMatch` (`**`, `*`, exakte Segmente); `isDenied` gegen `DENYLIST` (`.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, Dotfiles `**/.*`); `expandTarget('a/{{today}}.md', now)` → lokales `YYYY-MM-DD`.
  Testfälle: `../x` wirft; `.obsidian/a.md`, `_crews/teams/x.md`, `10_A/../.git/c` denied; `10_Aufgaben/**/*.md` matcht `10_Aufgaben/sub/t.md`, nicht `20_X/t.md`.
- [ ] Test-Helper: `InMemoryVaultPort` (Map-basiert; `patchFrontmatter` über simplen `---`-Block-Parser: flache Keys, Listen, Quoting erhalten wo unberührt); `FixtureMetadataPort` (Fixture-Map); `FakeClock` (manuell tickbar, Timer-Registry); `RecorderGitPort` (Aufruf-Log, konfigurierbares `status`); `RecorderReporter` (Event-Liste); `ScriptLlmClient` (Antwort-Queue je Call, Fehlerinjektion: throw/timeout/overflow-Flag).
- [ ] Commit `feat: core types, ports, path guards + test harness`.

## Phase B — Pure-Kern

### Task 4: CrewParser
**Files:** Create: `src/core/crew-parser.ts`; Test: `tests/core/crew-parser.test.ts`.
**Interfaces:** Consumes `MetadataPort`-Daten (fm+body als Parameter); Produces `parseAgentDef`, `parseTeamDef` (Skelett).
- [ ] `parseAgentDef`: Pflicht `crew-kind: agent`, `name`; Defaults temperature 0.1 / maxTokens 2048 / thinking 'auto' / model null; Body getrimmt = systemPrompt (leer → Fehler).
- [ ] `parseTeamDef`: alle Fehler SAMMELN, Format `<datei>: <feld>: <problem, erwartet …>`. Regeln: `crew-kind: team`, `version === 1`, `trigger === 'manual'`, tasks nicht leer, Task-IDs eindeutig, `inputs` referenzieren nur FRÜHERE Task-IDs, `agent ∈ knownAgents`, `outputSchema ∈ {triage-v1, briefing-v1}`, `allowed_actions ⊆ ActionType`, `write_scope`-Globs ∩ DENYLIST → Fehler, `limits.max_writes ≤ maxima.maxWrites` (fehlend → Settings-Default), snake_case-Frontmatter → camelCase-Def (`max_writes`→`maxWrites`, `write_scope`→`writeScope`, `output_schema`→`outputSchema`, `on_error`→`onError`, `allowed_actions`/`allowed_keys`/`target`).
  Testfälle: gültiges Minimal-Team; 5 Fehlerfälle einzeln + kombiniert (alle gemeldet, nicht first-fail); Vorwärts-Referenz in `inputs` → Fehler.
- [ ] Commit `feat: crew parser with exhaustive preflight validation`.

### Task 5: SlugMapper
**Files:** Create: `src/core/slug-mapper.ts`; Test: `tests/core/slug-mapper.test.ts`.
- [ ] `buildSlugTable(values)`: Muster `<nr>_<wort>_<emoji>` → Mittelteil; sonst NFD-normalisieren, Diakritika/Emoji strippen, lowercase, Leerzeichen→`-`; Kollision → Suffix `-2`, `-3`.
  Testfälle: `1_backlog_📥`→`backlog`; `6_erledigt_✅`→`erledigt`; `Später ⏳`→`spaeter`? NEIN — Umlaut-Behandlung: NFD-Strip macht `spater`; akzeptiert (dokumentieren). Kollision `x_a_📥`+`y_a_📥` → `a`,`a-2`. Roundtrip: `fromSlug[toSlug[v]] === v` für alle Inputs.
- [ ] Commit `feat: slug mapper (emoji enums ↔ ascii slugs)`.

### Task 6: Collectors + Pallas-Fixtures
**Files:** Create: `src/core/collectors.ts`, `tests/fixtures/pallas-tasknotes/*.md` (≥4: Emoji-Enums, `[null]`-Liste, gemischtes Quoting, fehlende Keys — anonymisiert nach realem Pallas-Muster); Test: `tests/core/collectors.test.ts`.
**Interfaces:** Produces `runCollector`, `fnv1a` (Skelett).
- [ ] `fnv1a` (32-bit, hex) testgetrieben.
- [ ] `vault.list`: folder+glob via MetadataPort, `limit`, Denylist-Filter. `vault.read`: explizite Pfade, Caps 32 KB/Datei + 256 KB gesamt, Kürzungs-Marker `[gekürzt]` im content, Denylist-Filter.
- [ ] `tasknotes.query`: `folder`, `where` (Key→Slug-Liste, OR innerhalb, AND zwischen Keys), `where_missing` (Key fehlt/null/leer), `sort` (Key, asc), `limit`, `fields`-Projektion. Normalisierung VOR Match: `[null]`→`[]`, fehlend→`null`; SlugTables je Key aus ALLEN Ist-Werten des folders bauen (Artifact.slugTables); frontmatter im Artifact slug-normalisiert; contentHash je Datei.
  Testfälle gegen Fixtures: where status=[backlog] trifft `1_backlog_📥`; where_missing priority; limit+sort deterministisch; `_crews/`-Datei nie geliefert.
- [ ] Commit `feat: collectors (list, read, tasknotes.query) with slug normalization`.

### Task 7: PromptBuilder + Budgeter
**Files:** Create: `src/core/prompt-builder.ts`; Test: `tests/core/prompt-builder.test.ts`.
**Interfaces:** Consumes `AgentDef`, `LlmTaskDef`, `Artifact`, `SchemaDef`; Produces `buildPrompt`, `estimateTokens` (Skelett).
- [ ] `estimateTokens = ceil(chars/3.5)`. System-Message: agent.systemPrompt + Output-Vertrag (fester Wortlaut: „Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen.") + Slug-Wertemengen (`Erlaubte Werte für <key>: a, b, c`) + `schema.jsonExample` als One-Shot. User-Message: instruction + je Input `=== KONTEXT: <taskId> (<n> Dateien) ===` + kompaktes JSON.
- [ ] `promptHash = fnv1a(alle Messages konkateniert)`; Determinismus-Test: gleiche Inputs → byte-gleich (Snapshot).
- [ ] `fitToBudget`: Budget = contextLength − maxTokens − 15 %; Kürzung blockweise von hinten (ganze Datei-Einträge), Marker `[gekürzt: N von M Einträgen enthalten]`, `truncated`-Flag; Instruction+Vertrag allein > Budget → wirft (`context_overflow` vor Call, Spec §3.3).
- [ ] Commit `feat: deterministic prompt builder with token budgeter`.

### Task 8: Schemas + OutputValidator + Fixture-Korpus
**Files:** Create: `src/core/schemas.ts`, `src/core/output-validator.ts`, `tests/fixtures/llm-outputs/*.txt` (≥8: Präambel-mit-Beispiel+echter-Block-am-Ende, `<think>`-Rest, trailing comma, smart quotes, abgeschnitten, kein JSON, falscher Slug, halluzinierter Pfad); Test: `tests/core/{schemas,output-validator}.test.ts`.
**Rohmaterial:** `extractJson`/`findBalanced`-Code im Scratchpad-Fragment (plan-part-1) — prüfen und übernehmen.
- [ ] `extractJson`: LETZTER ```json-Block zuerst, sonst erste balancierte `{}`/`[]`-Struktur (String-/Escape-bewusst); Repair-Pass: trailing commas, smart quotes; unbalanciert → `{ok:false, error:'output truncated'}`.
- [ ] `triage-v1`: `{items: [{path, set}]}`, maxItems 50; Quellbindung path ∈ sources; set-Keys frei (Executor prüft allowedKeys), set-Werte mit SlugTable → rück-mappen via `fromSlug`, unbekannter Slug → Fehler; → `FrontmatterPatchAction[]` (`remove: []`).
- [ ] `briefing-v1`: `{markdown: string}` ≤ 16 000 chars; `target === null` → Fehler; → `[SectionReplaceAction {path: target}]`.
- [ ] `validateOutput` = extract → schema.validate; `buildRepairPrompt(raw, errors)`: System „Du korrigierst JSON…", User = raw + Fehlerliste + „Gib NUR korrigiertes JSON in einem ```json-Block."
- [ ] Korpus-Test: jede Fixture → erwartetes ok/Fehler-Ergebnis tabellengetrieben.
- [ ] Commit `feat: builtin schemas (triage-v1, briefing-v1) + adversarial output validator`.

### Task 9–11: ActionExecutor, GitPlanBuilder, RunLogBuilder
**VOLL AUSGEARBEITET in `details/tasks-09-11-executor-gitplan-runlog.md` — daran implementieren.** Kernverträge (bindend): zweiphasig (erst ALLE validieren, dann anwenden); Guard-Reihenfolge normalize→denylist→writeScope→typ-spezifisch→stale→writeLimit; Konsistenz-Schwelle >50 % rejected+stale VOR erstem Write → taskFailed, nichts anwenden; `CREW_MARKER`-Blocksemantik mit Append beim ersten Mal; `buildCommitPlan`-Message `crew(<teamId>): run <runId> — <status>, <n> Dateien` + `Crew-Run:`-Trailer; `buildRunMd` Frontmatter nach Spec §2.4, Outcomes mit ✓/✗/↷/⊘. Drei Commits wie im Detail-Anhang.

### Task 12: LmStudioClient
**Files:** Create: `src/core/lmstudio-client.ts`, `tests/fixtures/streams/*.sse` (≥3, mit `<think>`); Test: `tests/core/lmstudio-client.test.ts`.
**Referenz:** `/Users/Shared/code/vault-rag/src/` (SSE-über-Transport-Muster, `/api/v0/models`-Feldnamen live prüfen).
- [ ] `ping` = GET `/v1/models` ok; `listModels` = `data[].id`; `modelInfo` = GET `/api/v0/models` → `loaded_context_length ?? max_context_length ?? null` (Feldnamen gegen vault-rag verifizieren), Fehler → null.
- [ ] `stream`: POST `/v1/chat/completions` (`stream: true`); Chunks → vendored `parseSSE` → `ThinkSplitter`; onToken nur Nicht-Think; thinkTokens zählen; `thinking: 'off'` → Suppression nach vault-rag-Muster.
- [ ] Timeouts via ClockPort: Hard `callTimeoutMs` ab Start; Stall `stallTimeoutMs` NUR nach erstem Token (Reset je Token). AbortSignal → `finishReason: 'aborted'`. HTTP ≠ 200: Fehler mit Status; 400 + „context length" im Body → Error mit `contextOverflow = true`.
  Testfälle: Fixture-Streams (FakeClock); Stall vor erstem Token feuert NICHT (JIT-TTFB, Spec §7); Stall nach erstem Token feuert; Abort mid-stream.
- [ ] Commit `feat: LM Studio client (streaming, think-splitting, JIT-aware timeouts)`.

### Task 13: Orchestrator (Run-FSM)
**Files:** Create: `src/core/orchestrator.ts`; Test: `tests/core/orchestrator.test.ts`.
**Interfaces:** Consumes ALLES aus Tasks 3–12; Produces `executeRun(teamPath, deps): Promise<RunResult>`.
**Zusatz-Vertrag (ergänzt Skelett):** llm-Artifact.json = `{ output: unknown; actions: Action[] }`; actions-Task konsumiert `actions` aus seinem inputs-Artefakt.
- [ ] PREFLIGHT exakt Spec §3.1 (Reihenfolge!): parse → endpoint (resolveActiveEndpoint, Denylist) → Modell in listModels + modelInfo → git.status (isRepo Pflicht, kein Merge/Rebase, index.lock 3×2 s Retry, baseSha) → Run-Lock (`runs/.lock`, verwaist > wallClockMs → übernehmen) → `runs/<runId>/` + run.md `running`. Jede Verweigerung → `refused` + errorKind, NICHTS ausgeführt.
- [ ] RUNNING sequenziell: collector → `runCollector`; llm → budget aus `modelInfo.contextLength ?? 8192` → `buildPrompt` → `stream` → `validateOutput` → bei !ok genau 1 Repair-Zyklus → bei !ok `on_error` abort|skip; actions → `expandTarget` → `executeActions`. contextOverflow-Error → Material halbieren, genau 1 Retry. Watchdog (Wanduhr) vor jedem Task. `state.json` + `run.md` nach JEDEM Task (`vault.modify`). Reporter-Events an allen Skelett-Punkten. llmCalls-Zähler ≤ maxLlmCalls.
- [ ] COMMITTING: Lock löschen (nie committen) → `buildCommitPlan` → `git.applyPlan` — IMMER, auch failed/aborted/0-Writes (Protokoll-Commit, Spec §5.2/5.3).
- [ ] FSM-Pfad-Tests mit ScriptLlmClient + RecorderGitPort (Aufruf-Reihenfolge!): ok · repair-ok · repair-fail-abort · repair-fail-skip · timeout · stall · overflow-retry-ok · abort mid-stream · watchdog · write_limit · consistency · git-refused · Lock-verwaist.
- [ ] Commit `feat: run orchestrator FSM (preflight, repair loop, partial commits)`.

## Phase C — Obsidian-Schicht

### Task 14–15: ChildProcessGitPort, Obsidian-Adapter + Transports
**VOLL AUSGEARBEITET in `details/tasks-14-15-gitport-adapter.md` — daran implementieren.** Kernverträge: git-Binary absolut resolven (`/usr/bin/git` zuerst — macOS-GUI-PATH); Commit-Message via `-F <msgfile>`; `git restore --source=<sha> --` statt checkout; Node-Imports NUR dynamisch hinter `Platform.isDesktop`; Integrationstests gegen echtes git in mkdtemp als `test:integration` (nicht im Default-`npm test`); `patchFrontmatter` via `fileManager.processFrontMatter`; `getBody` via `frontmatterPosition`; XhrSseTransport mit lastIndex-Delta-Parsing. Zwei Commits wie im Detail-Anhang.

### Task 16: Settings + i18n + main.ts
**Files:** Create: `src/obsidian/settings.ts`, `src/i18n/strings.ts`, `src/main.ts`; Test: `tests/obsidian/main.test.ts` (Smoke: Command-Registrierung, Wiring mit Mock).
- [ ] `PluginSettings` + Defaults exakt: endpoints `['http://localhost:1234/v1']`, deniedEndpoints `['http://localhost:8080','http://127.0.0.1:8080']`, defaultModel `''`, crewRoot `'_crews'`, maxWrites 10, wallClockMinutes 10, callTimeoutS 300, stallTimeoutS 60, verboseLogging false. SettingsTab 4 Gruppen (Spec §6.4), Connection-Test-Button (ping + Modelle), 8080-Erklärtext.
- [ ] `strings.ts`: defineStrings EN+DE für ALLE UI-Strings (Commands, Settings, Notices, Panel-Vokabular, Modals).
- [ ] `main.ts`: onload-Wiring aller Ports; Ein-Lauf-Mutex + AbortController; Commands: `run-crew` (FuzzySuggestModal, Zeile = Name + letzter Status aus data.json `lastRuns`), dynamische `run-crew:<teamId>`, `abort-current-run`, `undo-last-run` (Bestätigungs-Modal Team/Zeit/SHA/Dateien → `git.revert`; Konflikt → Notice + `restorePaths`-Angebot), `open-crews-panel`, `open-last-run-log`, `install-example-crews`. Nach Lauf: genau EINE Notice, `lastRuns` aktualisieren.
- [ ] Commit `feat: plugin shell (settings, i18n, commands, wiring)`.

### Task 17: RunPanel + Recovery
**Files:** Create: `src/obsidian/panel.ts`, `src/obsidian/recovery.ts`; Test: `tests/obsidian/panel.test.ts` (createObsidianMock + makeFakeEl).
- [ ] Panel-Zustände exakt Spec §6.2: Idle (Team-Liste + Run-Buttons, Status-Badges) · Running (Kopf `Task k/n`, Vokabular ⏳▶✓✗↷⊘, Token-Zeile collapsed, think-Zähler, EIN Abort-Button) · Done (Karte: Status, Datei-Links, Kurz-SHA, EIN Primärbutton kontextabhängig + dezenter Undo + „Nächste Handlung"-Zeile). DOM nur createEl/createDiv, kein innerHTML. Statusbar `⚙ k/n`.
- [ ] `recovery.ts`: onload-Check `runs/.lock` + `state.json status==='running'` → Modal mit EINER empfohlenen Aktion „Verwaisten Lauf abschließen (Teilstand committen)" → CommitPlan anwenden, run.md → `aborted`, Lock löschen.
- [ ] Commit `feat: run panel (idle/running/done) + crash recovery`.

## Phase D — Inhalte & Release-Gate

### Task 18: Beispiel-Crews + Installer
**Files:** Create: `src/obsidian/example-assets.ts` (Inhalte als TS-Konstanten — esbuild bündelt keine .md), `src/obsidian/install-examples.ts`, `assets/examples/*` (Quell-Wahrheit, von example-assets.ts gespiegelt); Test: `tests/obsidian/install-examples.test.ts`.
**Vorher klären (Pallas lesen, read-only):** Daily-Note-Pfadkonvention (periodic-notes data.json), realer Aufgaben-Ordner, EINE echte `.base` als Syntax-Referenz.
- [ ] Deutsche Prompts. `task-triage.md` nach Spec §2.3 mit realen Pallas-Pfaden. `daily-briefing.md`: collect (tasknotes.query heute fällig + überfällig) → schreibe (llm, briefing-v1, Agent briefing-autor: Abschnitte „Heute fällig / Überfällig / Eine nächste Handlung") → apply (actions, section.replace, target `<daily-ordner>/{{today}}.md`). Bewusste Vereinfachung ggü. Spec-§9-Wortlaut (1 llm-Task statt Analyst+Autor) — im Team-Body dokumentieren.
- [ ] `runs.base` (Syntax von echter Pallas-Base abgeschaut): Status/Team/Writes/error_kind-Spalten.
- [ ] Installer: legt `_crews/`-Struktur an, kopiert nur nicht-existierende Ziele, Notice mit Ergebnis.
- [ ] Commit `feat: example crews (task-triage, daily-briefing, runs.base) + installer`.

### Task 19: Golden-Run + Klon-Skript + Docs + Deploy-Probe
**Files:** Create: `tests/golden/daily-briefing.test.ts`, `scripts/clone-vault.sh`, `README.md`, `AGENTS.md`; Modify: `package.json` (deploy-Probe dokumentiert).
**Rohmaterial:** Golden-Run-Testcode im Scratchpad-Fragment (plan-part-3) — prüfen und übernehmen.
- [ ] Golden-Run: InMemory-Vault (Fixture-TaskNotes + Daily-Note) + ScriptLlmClient (feste Antwort) + FakeClock → `executeRun` → byte-exakter Vergleich: Daily-Inhalt nach section.replace, run.md (Epoch-ms normalisiert), CommitPlan am Recorder.
- [ ] `clone-vault.sh`: rsync Pallas → `/tmp/vault-crews-smoke` (exkl. `.git`, `.obsidian/workspace*`), `git init`; Kommentar-Anleitung.
- [ ] README (EN): Features, Requirements (LM Studio + **Enable CORS** für XHR-Streaming), BRAT-Install, Safety-Modell (write_scope, Git-Undo, Limits), Network-Disclosure (Community-Policy). AGENTS.md: Konventionen, Vendoring-Regel, `check:pure`, Smoke-Checkliste (Install-Command, beide Crews, Undo, Abort — gegen Klon, NIE echten Vault).
- [ ] `npm run gate` + Deploy-Probe auf Klon → Commit `docs: readme, agents.md, golden run, smoke tooling`.

---

## Selbst-Review-Checkliste (nach writing-plans, vor Implementierungsstart abgehakt)
- Spec-Coverage: §§1–9 V1-Scope → Tasks 1–19 zugeordnet (PREFLIGHT einzeln in T13, 4 Aktionen + Guards in T9, Fehlertabelle §7 verteilt auf T12/T13, UI §6 in T16/T17, Git §5 in T10/T13/T14). Nicht-V1-Punkte (§9) bewusst ohne Task.
- Typ-Konsistenz: alle geteilten Symbole nur aus Skelett; llm-Artifact-Format `{output, actions}` als Zusatz-Vertrag in T13 dokumentiert.
- Platzhalter: Task-Blöcke verweisen auf bindende Quellen (Spec/Skelett/Anhänge) statt auf Ungeschriebenes; keine offenen TBD.
