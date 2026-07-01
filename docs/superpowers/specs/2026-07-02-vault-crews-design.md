# Finales Design: „Vault Crews" — Autonome lokale LLM-Agenten-Teams als Obsidian-Plugin

**Manifest-id:** `vault-crews` (kebab-case, ohne „obsidian"; Uniqueness gegen `community-plugins.json` vor erstem Asset prüfen) · **Lizenz:** AGPL-3.0 · **`isDesktopOnly: true`** (localhost-LLM + `child_process`-git) · **Referenz-Vault:** 10_Pallas

**Synthese-Basis:** Rückgrat ist der Entwurf „robust" (bestbewertet bei Korrektheit und Wartbarkeit). Eingegraftet: die `enum_from`-Quellbindung, JIT-bewusste Stall-/Timeout-Behandlung und Marker-Idempotenz aus „mvp"; Slug↔Emoji-Mapping, metadataCache-Staleness-Fix, Golden-Run-Test, purer Commit-Plan und Bases-Beobachtbarkeit aus „vaultux". Die von den Judges benannten Schwächen von „robust" (Stall vs. JIT-TTFB, 180-s-Timeout, Extraktionsreihenfolge, Settings-Toggle-Last, Vorratsbau, unadressiertes Vendoring) sind behoben.

**Leitprinzip:** Lokale Modelle sind schwache, unzuverlässige Ausführende. Jede LLM-Ausgabe wird als feindlicher Input behandelt: orchestrator-geführte deterministische Pipeline statt freiem ReAct, constrain-then-verify vor jedem Schreibzugriff, Git-Netz unter jedem Lauf, vollständige Beobachtbarkeit als Vault-Notiz. Das LLM entscheidet ausschließlich *Inhalte* innerhalb enger Verträge; der Orchestrator entscheidet *Ablauf, Pfade, Schreibzugriffe*.

---

## 1. Architektur-Überblick

### 1.1 Schichtenmodell

```
┌─────────────────────────────────────────────────────────────┐
│ obsidian-Layer (src/obsidian/) — DARF obsidian importieren   │
│  main.ts · Commands · Ribbon · RunPanelView · SettingsTab    │
│  ObsidianVaultPort · ObsidianMetadataPort                    │
│  XhrTransport (SSE) / RequestUrlTransport (non-stream)       │
│  ChildProcessGitPort (dyn. import, Platform.isDesktop-Guard) │
├──────────────────────── Ports (Interfaces) ──────────────────┤
│ pure-Layer (src/core/) — obsidian-importfrei (PROF-OBS-03,   │
│ CI-grep-Gate)                                                │
│  CrewParser · Orchestrator (Run-FSM) · PromptBuilder         │
│  OutputValidator (Extraktion + eingebaute Schemata +         │
│    Quellbindung) · ActionExecutor (Guards, Limits, Stale)    │
│  Collectors · SlugMapper · Budgeter · RunLogBuilder          │
│  GitPlanBuilder (Commit-Message + Pfadliste, pure)           │
│  LlmClient-Interface + LmStudioClient (Transport injiziert)  │
├──────────────────────────────────────────────────────────────┤
│ obsidian-kit-Module (VENDORED aus #0.2.0, copy-not-share)    │
│  parseSSE · ThinkSplitter · normalizeEndpoint                │
│  resolveActiveEndpoint · i18n (EN/DE) — NICHTS davon neu     │
│  schreiben; src/vendor/kit/ mit Herkunfts-Headern (§10)      │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Ports (Dependency-Inversion, alle injiziert — der Headless-Hebel)

| Port | Verantwortung | Obsidian-Impl. | Test-Impl. |
|---|---|---|---|
| `VaultPort` | read/write/append/mkdir/list/exists/stat (immer `normalizePath`) | `app.vault` (+ `vault.process` für atomare Edits) | In-Memory-Map |
| `MetadataPort` | Frontmatter-Cache-Zugriff, Datei-Listen per Ordner (separater Port — sauberer Schnitt für Fixtures und Headless) | `metadataCache` | Fixture-Map |
| `LlmClient` | `ping`, `listModels`, `modelInfo` (tatsächlich geladene Kontextlänge!), `stream(messages, params, onToken, signal)` — Schnitt kompatibel zum vault-rag-`ChatClient`, damit später `@lmstudio/sdk` (JIT-Modell-Laden) als zweite Implementierung andockt | LM Studio via requestUrl (non-stream) + XHR+`onprogress` (stream, injizierter Transport — natives fetch ist lint-gesperrt, requestUrl kann nicht streamen) | Skript-Fake |
| `GitPort` | `isRepo`, `status`, `head`, `hasIndexLock`, `inMergeOrRebase`, `applyPlan(plan)`, `revert(sha)`, `restorePaths(sha, paths)` | `child_process.execFile("git", …)` hinter `Platform.isDesktop`, dynamischer Import | Recorder-Fake |
| `ClockPort` | `now()`, Timer (window-scoped, PROF-OBS-13) | `window.setTimeout` / `Date` | Fake-Clock |
| `RunReporter` | Ereignis-Senke (taskStarted, token, actionApplied, runFailed …) | Panel + run.md-Writer + Statusbar | Recorder |

Kein `RagPort` in V1 (YAGNI — Interface entsteht in V2 mit dem ersten Verbraucher `rag.search`).

### 1.3 Endpoint-Disziplin

- Standard: `http://localhost:1234/v1` (LM Studio, multi-client), Fallback-Liste via `resolveActiveEndpoint` mit injiziertem Ping.
- **Port 8080 (`mlx_lm.server`, Mono-Consumer-Lock durch OpenClaw) steht auf einer Endpoint-Denylist** — als *Default-Setting* mit erklärendem Text ausgeliefert, nicht im Code hartverdrahtet (Community-Tauglichkeit; für Johannes' Setup ist der Schutz ab Werk aktiv).
- Ollama `:11434` wird erst ab V2 (rag.search-Embeddings) berührt.

### 1.4 Verantwortlichkeits-Grundsatz

Orchestrator (deterministisch): welcher Task wann, welche Collectors, welche Schreibaktionen, Commit-Grenzen. LLM (probabilistisch, eingezäunt): genau ein strukturierter Output pro Task gegen einen eingebauten Vertrag. Guard-/Executor-Schicht (deterministisch): validiert jede Aktion gegen Whitelist, Limits, Quellbindung und Stale-Hash, *bevor* der VaultPort sie sieht. Genau **ein Lauf zur Zeit** (Run-Lock, §3.1).

---

## 2. Datenmodell (Teams/Agenten/Läufe im Vault)

### 2.1 Ordnerlayout (Wurzelordner konfigurierbar, Default `_crews/`)

```
_crews/
  agents/                    ← ein Agent = eine .md (Frontmatter + System-Prompt im Body)
    triage-analyst.md
    briefing-autor.md
  teams/                     ← ein Team = eine .md (Frontmatter = Pipeline)
    task-triage.md
    daily-briefing.md
  runs/                      ← Lauf-Protokolle; NIE Lese- oder Schreibziel von Agenten
    runs.base                ← mitgeliefertes Dashboard (Status, Team, Writes, error_kind)
    2026-07-02-0714-daily-briefing/
      run.md                 ← menschenlesbares Protokoll, Frontmatter Bases-tauglich
      state.json             ← Maschinenzustand (Crash-Recovery, Write-Register)
      artifacts/             ← NUR rohe LLM-Outputs aus Fehler-/Repair-Fällen (Fixture-Korpus)
```

**Prinzipien:** Alles ist Markdown/YAML — versionierbar, Bases-auswertbar (Agent-Fleet-Pattern). `_crews/**` steht komplett auf der **Lese- UND Schreib-Denylist** der Agenten-Tools (kein Prompt-Injection-Pfad in die eigene Steuerung, kein Selbst-Trigger). Das Plugin schreibt **nie** in Team-/Agent-Dateien zurück (kein `last_run`-Frontmatter-Churn); der letzte Lauf-Status lebt in `runs/` und `data.json`. Definitionen werden bei jedem Lauf-Start frisch geparst; Fehler brechen zeilen-genau **vor** dem ersten LLM-Call ab.

### 2.2 Agent-Schema (`_crews/agents/triage-analyst.md`)

```markdown
---
crew-kind: agent            # Diskriminator, Pflicht
name: Triage-Analyst
model: qwen/qwen3.6-35b-a3b # optional; Default aus Settings
temperature: 0.1            # Default 0.1 — Determinismus vor Kreativität
max_tokens: 2048
thinking: auto              # auto | on | off
---
Du bist ein nüchterner Task-Triage-Analyst für einen persönlichen Obsidian-Vault.
Du bewertest Aufgaben-Notizen anhand ihres Frontmatters und schlägst NUR
Metadaten-Korrekturen vor. Du erfindest nichts, du löschst nichts, du änderst
niemals title oder type. Bei Unsicherheit schlägst du NICHTS vor.
```

Body = System-Prompt-Kern (menschlich editierbare Prosa). Kein Tool-Wissen im Agenten — Verträge kommen pro Task aus dem Team (Agent = Stimme/Politik, Task = Vertrag). Dass reine Analysten nichts schreiben, ist strukturell garantiert: llm-Tasks berühren den Vault nie (§3.2).

### 2.3 Team-Schema (`_crews/teams/task-triage.md`)

```markdown
---
crew-kind: team
name: Task-Triage
version: 1                   # Schema-Version der Definition (Migrationspfad)
description: Prüft Backlog-TaskNotes auf fehlende/inkonsistente Metadaten.
trigger: manual              # V1: nur manual; V2: schedule; V3: event
limits:                      # ALLE optional — Defaults aus Settings, Plugin-Maxima deckeln
  max_writes: 15
write_scope:                 # Pfad-Whitelist des gesamten Teams (Glob, vault-relativ)
  - "10_Aufgaben/**/*.md"
tasks:
  - id: collect
    kind: collector          # deterministisch, KEIN LLM
    collector: tasknotes.query
    params:
      folder: 10_Aufgaben
      where: { status: [backlog] }        # ASCII-Slugs, nie Emoji-Literale (§3.5)
      limit: 25                            # hartes Batch-Limit → planbare Kontextgröße
      fields: [title, status, priority, kontext, projekt, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]        # explizite Kontext-Übergabe, nichts implizit
    instruction: |
      Bewerte jede Aufgabe: fehlende priority? leerer kontext?
      Schlage pro Aufgabe höchstens eine Frontmatter-Korrektur vor.
    output_schema: triage-v1 # eingebautes, versioniertes Schema (§3.4)
    on_error: abort          # optional; Default abort, Alternative skip
  - id: apply
    kind: actions            # deterministischer Executor, KEIN LLM
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, kontext, projekt, period]   # nie status, nie type
---
Freitext darunter: Doku für Menschen. Wird nicht geparst.
```

**Bewusster Trade-off (Judges gegeneinander abgewogen):** Die Pipeline lebt im Frontmatter (Maschine) — nicht als YAML-Block im Body (fragile Prosa/Maschine-Vermischung, verworfen aus „vaultux"). Restrisiko: Obsidians Property-Editor kann verschachtelte Strukturen beschädigen. Mitigation: vollständige Preflight-Validierung mit präziser Fehlermeldung, Doku-Hinweis „Team-Dateien im Source-Modus editieren", `version`-Feld als Migrationsanker. Risiko dokumentiert (§10).

### 2.4 Lauf-Protokoll (`runs/<id>/run.md`)

Frontmatter (flach, Bases-tauglich): `crew-kind: run`, `team`, `started`, `ended`, `status: ok|partial|failed|aborted|refused`, `commit`, `writes`, `llm_calls`, `duration_s`, `model`, `error_task`, `error_kind` (typisierte Fehlerklasse → „welche Fehlerklasse häuft sich?" per Base auswertbar). Body: pro Task ein Abschnitt mit Modell, Dauer, Prompt-Hash (Determinismus-Beweis), validiertem Artefakt als ```json-Block, angewandten/verworfenen/stale Aktionen (Pfad + Ein-Zeilen-Diff-Summary), Fehlern im Klartext, Abschlusszeile mit Commit-SHA und Undo-Hinweis.

Geschrieben wird **inkrementell nach jedem Task** (Crash-Sicherheit). Rohe LLM-Outputs landen nur bei Validierungs-/Repair-Fällen als Datei in `artifacts/` — genau dort wächst der Test-Fixture-Korpus, ohne bei ok-Läufen Datei-Rauschen zu erzeugen (Setting „verbose logging" schaltet Voll-Mitschnitt zu). Eine mitgelieferte `runs.base` plus ein dokumentiertes Cockpit-Base-Snippet („🤖 Crews: braucht Aufmerksamkeit") liefern Beobachtbarkeit mit Bordmitteln — das Plugin fasst `_Cockpit.md` **nie selbst** an.

### 2.5 Frontmatter-Realität (verifiziert am Pallas-Vault, verbindlich)

Echte TaskNotes zeigen gemischte Quoting-Stile, Emoji-Enum-Werte (`1_backlog_📥`, `2_mittel_🟡`), Listen mit Null-Einträgen (`kontext:\n  -` → `[null]`), fehlende Keys. Konsequenzen:

1. **Nie ganzes Frontmatter re-serialisieren.** Nur `frontmatter.patch` auf einzelne Keys via `FileManager.processFrontMatter`; alle anderen Bytes bleiben Original (Smart-Apply-Muster aus vault-rag).
2. **Enum-Werte werden vor jedem Lauf aus dem Vault enumeriert** (Ist-Werte aller Task-Notizen), nicht hartkodiert und nicht manuell gepflegt. Outputs außerhalb der Menge = Validierungsfehler.
3. **Slug↔Emoji-Mapping (aus „vaultux", ohne dessen `_types`-Kopplung):** Aus den enumerierten Ist-Werten leitet der `SlugMapper` deterministisch ASCII-Slugs ab (`6_erledigt_✅` → `erledigt`); das Modell sieht und produziert nur Slugs, der Executor mappt byte-genau zurück. Kein Tokenizer-Roulette mit Emojis.
4. `[null]`-Listen und fehlende Keys werden im Collector normalisiert (→ `[]` / `null`) — das Modell sieht nie YAML-Pathologien.

---

## 3. Orchestrator (Ablauf eines Team-Laufs)

### 3.1 Run-Zustandsmaschine (deterministisch, kein LLM in der Steuerung)

```
IDLE → PREFLIGHT → RUNNING(task 1..n, streng sequenziell) → COMMITTING → DONE
            │            │                                       │
            └→ REFUSED   └→ FAILED(task k) / ABORTED (User) ─────┘ (Partial-Commit, §5.3)
```

**PREFLIGHT (harte Gates, bevor irgendetwas passiert):**
1. Team + Agenten parsen und vollständig validieren (referenzierte Agenten/Schemata existieren, `write_scope` kollidiert nicht mit Denylist, Limits ≤ Plugin-Maxima, alle `inputs`-Referenzen auflösbar).
2. Endpoint via `resolveActiveEndpoint` (Denylist-geprüft); Modell in `/v1/models`; `modelInfo` → **tatsächlich geladene Kontextlänge** für den Budgeter.
3. Git: `isRepo`? **Kein Repo → Lauf verweigert, keine Ausnahme, kein Setting** (das Undo-Netz ist nicht verhandelbar — eine Entscheidung weniger). Kein laufender Merge/Rebase (aus „vaultux"). `index.lock` frei (3 Retries à 2 s). HEAD-SHA als `base_sha` merken. Dirty-State ist ok (Commit erfasst nur eigene Pfade), wird aber protokolliert.
4. Run-Lock: plugin-globales Mutex + Lock-Datei in `runs/`; verwaister Lock (älter als Watchdog-Limit) wird als solcher markiert und übernommen.
5. `runs/<id>/` anlegen, `run.md` mit `status: running` — ab jetzt ist der Lauf im Vault sichtbar.

Jeder PREFLIGHT-Fehler → REFUSED: nichts ausgeführt, eine Notice mit exakter Ursache + run.md-Eintrag.

### 3.2 Drei Task-Arten (nicht mehr)

| kind | Wer führt aus | Zweck |
|---|---|---|
| `collector` | Plugin, deterministisch | Kontext beschaffen (Datei-Listen, TaskNotes-Query, Inhalte). Ergebnis = normalisiertes, geslugtes JSON-Artefakt inkl. Content-Hash pro Datei (Stale-Guard §4.4). |
| `llm` | Ein Agent, genau **ein** Chat-Completion-Call (+ max. 1 Repair-Call) | Denken/Bewerten/Formulieren. Ergebnis = validiertes JSON- oder Markdown-Artefakt. |
| `actions` | Plugin-Executor, deterministisch | Validierte Aktionsliste eines vorherigen llm-Tasks auf den Vault anwenden (§4). |

Das LLM steuert **nie** den Kontrollfluss und berührt **nie** direkt den Vault — es transformiert Daten zwischen zwei deterministischen Stufen. Kein ReAct, keine modell-entschiedenen Schleifen, kein natives Tool-Calling in V1.

### 3.3 Kontext-Übergabe, Prompt-Aufbau, Budget

- Jeder Task deklariert `inputs: [task_ids]` — nur diese Artefakte landen im Prompt, in klar delimitierten Blöcken (`=== KONTEXT: collect (25 Aufgaben) ===`). Kein wachsender Gesprächsverlauf; jeder llm-Call ist frisch, in sich vollständig, reproduzierbar (byte-gleicher Prompt bei gleichem Vault-Zustand, per Prompt-Hash belegt).
- **Prompt-Schichtung:** System = Agent-Body + Output-Vertrag („Antworte ausschließlich mit einem JSON-Objekt in einem ```json-Block, keine Erklärungen") + geschlossene Slug-Wertemengen. User = Task-`instruction` + Kontextblöcke + **One-Shot-Minimalbeispiel** des erwarteten JSON (messbar wichtiger als Schema-Prosa bei kleinen Modellen).
- **Budgeter:** Schätzung chars/3.5 (konservativ für Deutsch); Budget = geladene Kontextlänge (aus `modelInfo`) − `max_tokens` − 15 % Reserve. Überlauf → deterministische, blockweise Kürzung von hinten mit explizitem Marker im Prompt (`[gekürzt: 18 von 25 Einträgen — das Modell weiß, dass es unvollständige Daten sieht]`), protokolliert. Instruction + Vertrag allein > Budget → Task-Fail **vor** dem Call.
- **Reaktiver Overflow-Pfad (aus „mvp"):** Antwortet der Server trotz Budgeter mit 400/„context length" → Kontextmaterial halbieren, genau ein Retry, dann FAILED.
- `<think>`-Ströme der Qwen-Modelle laufen durch obsidian-kit-`ThinkSplitter`: nie im Artefakt, nie im Folge-Prompt; im Panel nur als Zähler, aufklappbar (§6.2).
- **Kein `json_schema`-API-Modus** (an LM Studio bei Reasoning-Modellen kaputt, tool_choice-400) — prompt-basiertes JSON mit nachgelagerter Validierung ist der einzige V1-Pfad, einheitlich für alle Modelle.

### 3.4 Output-Validierung (constrain-then-verify, Stufe 1)

1. **Extraktion (Reihenfolge aus „mvp"):** zuerst der **letzte** ```json-Block (Reasoning-Modelle zitieren in der Präambel gern das Beispiel), sonst die erste balancierte `{…}`/`[…]`-Struktur; tolerant gegen Fences und Geschwätz; leichter Repair-Pass (trailing commas, smart quotes, Abschneide-Erkennung).
2. **Schema-Validierung:** handgeschriebener Mini-Validator (Objekt/Array/String/Number/Enum, Pflichtfelder, maxItems/maxLength) gegen **eingebaute, versionierte Schemata** (`triage-v1`, `briefing-v1`) — bewusst kein Ajv (eval-Compile, PROF-OBS-12) und **keine user-definierbare Schema-DSL in V1** (verhindert Forever-Kompatibilitätsfläche; Trade-off in §10).
3. **Quellbindung (die `enum_from`-Idee aus „mvp", als festes Schema-Feature):** Pfad-Felder eingebauter Schemata sind immer an das Material der deklarierten `inputs` gebunden — jeder vom LLM gelieferte Pfad **muss** dort vorkommen. Pfad-Halluzination ist damit strukturell unmöglich, nicht nur geprüft. Analog: Enum-Felder ∈ Slug-Wertemenge, Aktionsanzahl ≤ Limits.
4. **Repair-Loop, genau 1 Versuch:** „Hier deine Ausgabe, hier die konkreten Fehler, gib NUR korrigiertes JSON" (Temperatur niedrig, thinking off wenn möglich). Roh-Output landet in `artifacts/`. Scheitert auch der Repair → Task-Fail nach `on_error`.

---

## 4. Tool-System

### 4.1 Grundentscheidung: Collectors + deklarative Aktionslisten, kein Tool-Calling

Lese-„Tools" sind Collectors (Plugin führt aus, deklarative Parameter aus der Team-Datei). Schreib-„Tools" sind Aktionen: der llm-Task liefert eine JSON-Aktionsliste, der `actions`-Task validiert und wendet an. Ein einziger Validierungspunkt, keine Tool-Roundtrips mit schwachen Modellen, triviale Testbarkeit. Natives Tool-Calling bleibt als V2-Option hinter dem `LlmClient` abstrahiert (begrenzter Read-only-Loop für fähige Modelle, Capability-Detection nach vault-rag-Muster).

### 4.2 V1-Collector-Katalog (vollständig)

| Collector | Funktion |
|---|---|
| `vault.list` | Dateiliste per Ordner+Glob (MetadataPort), mit `limit` |
| `vault.read` | Inhalte explizit gelisteter Pfade (Größen-Cap pro Datei und gesamt, Kürzungs-Marker) |
| `tasknotes.query` | Frontmatter-Filter-DSL: `folder`, `where` (Key→Slug-Werteliste), `where_missing`, `sort`, `limit`, `fields`-Projektion; Normalisierung + Slug-Mapping nach §2.5 |

Lese-Denylist für alle Collectors: `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`. **metadataCache-Staleness-Fix (aus „vaultux"):** Collectors im selben Lauf ergänzen eigene, bereits geschriebene Pfade aus dem Write-Register — der Cache-Lag kann keine widersprüchlichen Zwischenstände liefern.

`rag.search` (Retrieval über den `_vaultrag`-Index, Query-Embedding via Ollama `:11434`) ist **entschieden V2** — die V1-Teams brauchen es nicht.

### 4.3 V1-Aktionskatalog (vollständig)

| Aktion | Parameter | Verify-Stufe 2 (vor Anwendung, deterministisch) |
|---|---|---|
| `frontmatter.patch` | `path`, `set`, `remove` | Key ∈ `allowed_keys` des Tasks (harte Keys wie `status`/`type` stehen dort per Konvention nie drin — die Beispiel-Teams patchen nur weiche Felder); Wert ∈ enumerierter Wertemenge (rück-gemappt vom Slug); Original-Bytes-Erhalt, Frontmatter danach re-parsebar (assertParseable), sonst Rollback der Einzelaktion |
| `note.create` | `path`, `content` | Pfad ∈ `write_scope`, existiert noch nicht (nie überschreiben), `.md`, ≤ 64 KB |
| `note.append` | `path`, `heading?`, `content` | Pfad ∈ `write_scope`; mit `heading` ans Section-Ende, sonst Dateiende; Größen-Cap |
| `section.replace` | `path`, `marker`, `content`, `create_if_missing: false` | ersetzt idempotent den Block zwischen `<!-- crew:<team> -->`-Markern (legt ihn beim ersten Mal ans Dateiende); Rest der Datei byte-identisch; fehlendes Ziel → kontrollierter Task-Fail mit klarer Meldung, keine stille Ersatzhandlung |

`section.replace` (aus „mvp"/„vaultux") ist der Idempotenz-Anker: Wiederholung ist billig und sicher — **Idempotenz statt Resume-Komplexität**. Nicht in V1: delete, rename/move, Body-Rewrite ganzer Notizen, Nicht-Markdown-Dateien.

### 4.4 Schutzmechanismen (Executor-Ebene, unumgehbar, alles pure & getestet)

- **Pfad-Whitelist:** jede Schreibaktion muss `write_scope` matchen (Glob nach `normalizePath`, `..` verboten). Feste Denylist, die Whitelists nie überstimmen: `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, Dotfiles.
- **Quellbindung** (§3.4): Pfade können nicht erfunden werden.
- **Schreiblimits:** `max_writes` pro Lauf (Default 10), Größen-Caps, nur `.md`, LLM-Call-Zähler (Tasks × 2 wegen Repair). Limit erreicht → Lauf-Fail mit Partial-Commit, keine stille Drosselung.
- **Stale-Write-Guard:** Content-Hash beim Collect; hat der User die Datei zwischenzeitlich geändert → Einzelaktion wird als `⊘ stale` übersprungen und protokolliert. Kein Lost-Update, kein Ganz-oder-gar-nichts.
- **Konsistenz-Schwelle (behebt Judge-Schwäche):** Werden > 50 % der Aktionen eines Tasks verworfen/stale, gilt der Task als FAILED statt teilangewandt — schützt vor semantisch inkonsistenten Teilzuständen; darunter gilt Einzelaktion-Skip mit Zähler im Log.
- **Runaway-Watchdog:** Wanduhr-Limit (Default 10 min), Überschreitung → ABORTED mit Partial-Commit.
- **Selbst-Trigger-Fundament ab V1:** Write-Register aller Pfade in `state.json`; die V3-Datei-Events prüfen dagegen (plus Debounce, Cooldown, `_crews/**`-Ausschluss) — keine spätere Nachrüst-Lücke.

---

## 5. Git-Checkpoint-Mechanik

### 5.1 Entscheidung: `child_process` git

`child_process.execFile("git", …)` hinter `Platform.isDesktop` + dynamischem Import. **Verworfen:** isomorphic-git (zweite Git-Implementierung im selben Repo → Index-Drift/`index.lock`-Kollision mit obsidian-git, Bundle-Gewicht, langsam) und obsidian-git-Plugin-API (keine stabile öffentliche API, fremdes Release-Tempo). obsidian-git bleibt Sync/History-UI des Users; wir teilen nur das Repo. Koexistenz: Existenz-Detection von obsidian-git + einmaliger Settings-/Doku-Hinweis (Auto-Backup-Intervall ≥ 30 min empfohlen) und `index.lock`-Retry — **kein Parsen der fremden data.json** (ungetypte Cross-Plugin-Kopplung, verworfen).

### 5.2 Commit pro Lauf (Commit-Plan pure, Ausführung dumm)

1. PREFLIGHT merkt `base_sha`; Merge/Rebase- und Lock-Checks (§3.1).
2. Der Executor schreibt direkt in den Vault (User-Entscheidung: kein Approval-Gate) und registriert jeden Pfad.
3. Der **GitPlanBuilder (pure, aus „vaultux")** berechnet aus dem Lauf-Zustand Commit-Message + exakte Pfadliste; der GitPort führt nur aus: `git add -- <registrierte Pfade + runs/<id>/**>` (**nie** `add -A` — der Dirty-State des Users bleibt unberührt), dann `git commit -m "crew(task-triage): run 2026-07-02-0714 — ok, 7 Dateien"` mit Body (Dateiliste, Run-ID, run.md-Pfad, Status) und Trailer `Crew-Run: <run-id>`.
4. run.md/state.json/artifacts wandern **mit** in denselben Commit (Wirkung + Protokoll atomar; Protokollverlust beim Revert ist akzeptierter Kollateralschaden).
5. Null Schreibaktionen → nur der Protokoll-Commit (feste Regel, kein Setting: lückenlose Historie).

### 5.3 Fehlschlag mitten im Lauf, Crash, Undo

- **FAILED/ABORTED mit Teil-Writes → trotzdem committen** (`crew(<team>): PARTIAL run <id> (failed at analyse, 2/3)`). Uncommittete Teil-Writes wären der gefährlichste Zustand — unsichtbar, nicht als Einheit revertierbar. run.md nennt exakt, was angewendet wurde.
- **Obsidian-Crash mid-run:** Beim nächsten Plugin-Load erkennt PREFLIGHT die verwaiste Lock-Datei + `state.json` mit `status: running` → Recovery-Dialog mit genau **einer** empfohlenen Handlung: „Verwaisten Lauf abschließen (Teilstand committen)".
- **Undo = `git revert <run-sha>`** (One-Click, kein History-Rewrite). Revert-Konflikt (User hat seither editiert) → Revert sauber abbrechen, Meldung mit Datei-Liste + Fallback-Angebot pro Datei (`restorePaths(base_sha, [path])`), niemals stiller Merge.

---

## 6. UI/UX (ND-freundlich: deterministisch, minimale Entscheidungslast)

### 6.1 Commands (sentence-case, keine Default-Hotkeys, PROF-OBS-14)

- `Run crew…` — Fuzzy-Picker über Teams; pro Team eine Zeile mit Zweck + letztem Lauf-Status (aus „vaultux"). Enter = läuft, keine weiteren Dialoge.
- `Run crew: <Name>` — dynamisch pro Team registriert (stabile IDs aus Datei-Slug; hotkey-fähig, Zeitplan-Vorstufe).
- `Abort current run` · `Undo last run` (Bestätigungs-Modal zeigt exakt: Team, Zeitpunkt, Commit, Dateien — ein Button) · `Open crews panel` · `Open last run log` · `Install example crews`.
- Ribbon-Icon öffnet **nur das Panel** — kein Direktstart, kein versehentlicher Lauf.

### 6.2 Run-Panel (rechte Sidebar, ItemView — immer gleiches, ruhiges Layout)

- **Idle:** Team-Liste (Name, Beschreibung, letzter Lauf als Status-Badge + relative Zeit), pro Team ein „Run"-Button. Keine Konfiguration im Panel — konfiguriert wird in den Team-Dateien (ein Ort, eine Wahrheit).
- **Running:** Kopf „Task 2/3: analyse"; pro Task eine Zeile mit festem Vokabular: `⏳ wartet · ▶ läuft · ✓ ok · ✗ fehlgeschlagen · ↷ übersprungen · ⊘ stale`. Token-Strom default **eingeklappt** auf eine Fortschrittszeile; `<think>` nur als Zähler („denkt… 340 Token"), aufklappbar, nie aufgedrängt. Genau ein roter Button: **Abbrechen** (AbortSignal kappt den XHR → Partial-Commit-Pfad; Abbrechen ist immer sicher — die zentrale Angstfrei-Garantie neben Undo).
- **Done:** Ergebnis-Karte (Status, geschriebene Dateien als Links, Commit-Kurz-SHA, Dauer) + genau **ein** Primärbutton je Zustand: nach ok „Log öffnen"; nach Fehler **„Fehlerstelle ansehen"** (öffnet run.md direkt am fehlgeschlagenen Task, aus „vaultux"). Sekundär, dezent: „Rückgängig". Darunter immer genau eine „Nächste Handlung"-Zeile.
- **Null Rückfragen während eines Laufs** (alle Entscheidungen stehen vorab in der Team-Datei); genau eine Notice pro Lauf-Ende, kein Toast-Spam; Statusbar zeigt unaufdringlich `⚙ 2/3`. Beobachtung über Zeit geschieht **im Vault** (run.md, runs.base, Cockpit-Snippet), nicht in Plugin-Fenstern.

### 6.3 Determinismus-Zusagen

Gleiche Team-Datei + gleicher Vault-Zustand ⇒ gleiche Collector-Ergebnisse, byte-gleiche Prompts (Prompt-Hash beweist es), gleiche Reihenfolge, gleiche Limits. Einzige Nichtdeterminismus-Quelle ist das Modell (Temperatur 0.1 als Default). Keine versteckten Heuristiken, keine adaptiven Retries jenseits des dokumentierten einen Repair-Versuchs.

### 6.4 Settings (deklarative Settings-API, PROF-OBS-06, i18n EN/DE)

Vier Gruppen: **Connection** (Endpoint-Fallback-Liste + Denylist mit 8080-Default, Test-Button, Default-Modell aus `/v1/models`) · **Crews** (Wurzelordner, Beispiel-Crews installieren) · **Safety** (Default-Limits + Plugin-Maxima) · **Advanced** (Timeouts, verbose logging). **Bewusst entfernt** (gegenüber „robust"): die Toggles „ohne Git erlauben" und „Läufe immer committen" — harte Regeln statt Optionen sind hier die ND-freundlichere Wahl.

---

## 7. Fehlerbehandlung (was geht schief → was passiert → was sieht Johannes)

| Fehler | Erkennung | Verhalten | Sichtbarkeit |
|---|---|---|---|
| Endpoint weg (vor Lauf) | PREFLIGHT-Ping über Fallback-Liste | REFUSED, nichts ausgeführt | Notice mit einer Handlung („LM Studio starten, dann erneut ausführen") + run.md |
| Endpoint stirbt mid-run | XHR-Error/SSE-Abriss | 1 Retry desselben Calls nach Re-Resolve; dann Task-Fail → i. d. R. FAILED + Partial-Commit | Panel ✗ + Log mit HTTP-Detail |
| Timeout / Stall | Hard-Timeout pro Call **300 s** (JIT-Modell-Laden braucht Luft); **Stall-Detektor (60 s ohne neues Token) erst nach dem ersten Token scharf** — vor dem ersten Token gilt nur der Hard-Timeout (behebt die JIT-TTFB-Kollision aus „robust") | wie Endpoint-Abriss | Ursache „timeout" vs. „stalled" unterschieden |
| Kaputtes JSON | Extraktion/Schema/Quellbindung | genau 1 Repair-Call, dann Task-Fail nach `on_error` | Roh-Output in artifacts/, Fehlerliste im run.md |
| Halluzinierte Pfade/Enums | Quellbindung + Wertemengen-Check | Einzelaktion verworfen; > 50 % verworfen → Task-Fail (Konsistenz-Schwelle) | „2 Aktionen verworfen: Pfad nicht im Quellmaterial" |
| Kontextfenster-Überlauf | präventiv: Budgeter gegen modelInfo-Kontextlänge; reaktiv: Server-400 „context length" | Kürzung mit Marker, protokolliert; reaktiv Material halbieren + genau 1 Retry; unlösbar → Task-Fail **vor** dem Call | Kürzungs-Notiz im run.md |
| Falsches/kein Modell | PREFLIGHT `/v1/models` + modelInfo | REFUSED mit Modell-Name | Notice + Log |
| User editiert Datei während des Laufs | Stale-Hash beim Write | Einzelaktion `⊘ stale`, nie überschreiben | Panel + Log + „Nächste Handlung" |
| Write-Ziel fehlt (`create_if_missing: false`) | Executor | kontrollierter Task-Fail („Daily 2026-07-02.md existiert nicht — zuerst Daily anlegen") | klare Meldung, keine stille Ersatzhandlung |
| Obsidian-Crash mid-run | verwaiste Lock-Datei + state.json beim Load | Recovery-Dialog, eine empfohlene Handlung: Teilstand committen | Dialog |
| Kein Git-Repo / git fehlt / Merge läuft | PREFLIGHT | REFUSED — hart, kein Opt-out | erklärende Notice + Setup-Hinweis |
| Team-Datei fehlerhaft | Parse bei Lauf-Start (frisch, kein Cache-Drift) | REFUSED mit Datei + Feld + Erwartung | präzise Fehlermeldung |
| Teilfortschritt | run.md inkrementell + Partial-Commit | **kein Resume in V1** — Wiederholung ist dank `section.replace`/Overwrite-Verweigerung/Patch-Semantik idempotent und billig | Log dokumentiert exakt den Stand |

Grundsatz: **Fehler sind laut, präzise, folgenlos** — nichts Halbes ohne Commit + Log, nie stilles Weiterwursteln. Jede Meldung nennt: was passiert ist, was schon committet wurde, die eine nächste Handlung. Fehlerklassen sind typisiert (`error_kind`) und per Base auswertbar.

---

## 8. Testing-Strategie

- **Setup:** Vitest node-env; Obsidian-Mock via `resolve.alias` auf `tests/__mocks__/obsidian.ts` (vendorte Kopie von obsidian-kit/testing: `createObsidianMock`, `makeFakeEl` — self-contained, keine git-Dep, s. §10 Risiko 1); tsconfig-Split ohne Mock-Alias im Build-/Lint-tsconfig (PROF-TS-04/PROF-OBS-08). TDD-Default.
- **Pure-Layer = Hauptmasse (keine Mock-Akrobatik):**
  - *CrewParser:* gültige/kaputte Fixtures (fehlende Pflichtfelder, unbekannte kinds, Scope/Denylist-Kollision, unaufgelöste inputs) → präzise Fehlermeldungen als Vertrag.
  - *PromptBuilder:* Golden-/Snapshot-Tests byte-genauer Prompts — Determinismus-Beweis.
  - *OutputValidator:* Korpus realer kaputter Modell-Outputs (Fences, Präambeln mit JSON-Beispielen, `<think>`-Reste, abgeschnittenes JSON, falsche Slugs) — der Korpus wächst automatisch aus `artifacts/` echter Fehlläufe.
  - *ActionExecutor:* In-Memory-VaultPort; Whitelist/Denylist/Limit/Stale/Konsistenz-Schwelle als vollständige Matrix; **Property-Tests für Guards** (Globs, `..`-Escapes — aus „mvp"); Frontmatter-Patches gegen **echte Pallas-Fixtures** inkl. `[null]`-Listen und Emoji-Enums (Bytes-Erhalt-Assertions).
  - *SlugMapper:* Roundtrip-Tests gegen reale Enum-Wertemengen.
  - *Orchestrator:* Skript-LlmClient mit Fehlerinjektion (Timeout beim 2. Call, Müll beim Repair, Abbruch mid-stream, 400-Overflow) → jeder FSM-Pfad inkl. Partial-Commit-Aufrufreihenfolge am Recorder-GitPort; Fake-Clock für Watchdog/Stall.
  - *Budgeter/GitPlanBuilder:* tabellengetrieben.
- **Golden-Run-Test (aus „vaultux"):** komplette Daily-Briefing-Pipeline mit gescripteten LLM-Antworten → byte-exakter Vergleich geschriebener Notes + run.md + Commit-Plan. Der Regressions-Anker.
- **Mock-Grenze = Port-Grenze:** Obsidian-Schicht nur dünn testen (Command-Registrierung, Adapter-Smoke); SSE/XHR mit aufgezeichneten LM-Studio-Fixtures (echte Qwen-Streams inkl. `<think>`) gegen injizierten Fake-XHR (vault-rag-Muster). Nie `app` tief mocken.
- **GitPort:** Integrationstests gegen echtes git im Temp-Verzeichnis (`test:integration`-Marker): commitPaths, revert, restorePaths, Konflikt, index.lock.
- **Kein Live-LLM in CI**; manuelle Smoke-Checkliste gegen einen **Wegwerf-Klon** des Pallas-Vaults (Klon-Skript in `scripts/`, nie der echte Vault) als Release-Gate.
- **CI-Gates:** typecheck, vitest, eslint-plugin-obsidianmd (type-checked), CI-grep gegen obsidian-Imports in `src/core/` und `innerHTML`-Writes (PROF-OBS-03/13).

---

## 9. Ausbaustufen (V1/V2/V3)

### V1 — „Zwei Teams, ein Knopf, ein Commit" (End-to-End nutzbar, Task-Assistenz ab Tag 1)
- Scaffold aus `templates/obsidian-plugin/` (esbuild cjs, Release-Toolchain, i18n EN/DE ab Commit 1).
- Manueller Trigger, ein Lauf zur Zeit; sequenzieller Orchestrator mit drei Task-Arten; 3 Collectors + 4 Aktionen; eingebaute Schemata `triage-v1`/`briefing-v1` mit Quellbindung; Slug-Mapping + Enum-Enumeration; Guards komplett; Git-Checkpoint + Undo + Crash-Recovery; Run-Panel; run.md + state.json + fehlerfall-artifacts + runs.base + Cockpit-Snippet (Doku).
- **Zwei mitgelieferte Beispiel-Crews** (per Command installierbar, danach User-editierbar): **Task-Triage** (§2.3) und **Daily-Briefing** (Collector: heutige + überfällige Tasks → Analyst-JSON → Autor-Markdown → `section.replace` in der heutigen Daily Note, `create_if_missing: false`).
- **Explizit nicht in V1:** Scheduler, Datei-Events, Chat, `rag.search`/RagPort, natives Tool-Calling, delete/rename/move, Body-Rewrites, frei definierbare Schemata, Resume, Mobile, `@lmstudio/sdk`, Capability-Detection.

### V2 — Verlässlicher Alltag
- **Zeitplan-Trigger:** `trigger: schedule` (Minimal-Syntax); nur bei offenem Obsidian; verpasste Läufe beim Öffnen nachgeholt — max. 1 Nachholung pro Team, mit Notice, nie stumm; Dedup über `last_run` (Idempotenz via `section.replace` trägt den Rest).
- `rag.search`-Collector über den `_vaultrag`-Index (Query-Embedding via Ollama `:11434`; Dim-/Manifest-Check, sonst klare Verweigerung) → Use-Case 3.
- Vault-Gärtner: Inbox-Move (rename mit Backlink-Erhalt über Obsidian-API), Tag-/Link-Vorschläge — jede neue Fähigkeit mit eigenem Verify.
- Resume ab fehlgeschlagenem Task (state.json existiert dafür schon — aber der Code entsteht erst jetzt).
- Capability-Detection + begrenzter Read-only-Tool-Call-Loop für fähige Modelle; `@lmstudio/sdk`-LlmClient (JIT-Modell-Laden, Modell pro Agent ernsthaft nutzbar); parametrisierbare Erweiterungen der eingebauten Schemata; Cockpit-Pflege-Team (mit Section-Ownership-Markern).

### V3 — Ereignisse, Gespräch, Framework
- **Datei-Event-Trigger** (Ordner-Scopes, Debounce ~30 s, Cooldown, Rate-Limit, Selbst-Trigger-Register aus §4.4 scharf geschaltet, `_crews/**` triggert nie).
- **Chat-UI** (Chat-Turn = Ad-hoc-Lauf mit dem Chat-Text als Input-Artefakt).
- User-definierte Output-Schemata im Team-YAML (Schema-DSL — erst jetzt, wenn der Bedarf bewiesen ist); Vorlagenkatalog; Headless-Erkundung (die Ports zahlen sich aus).
- **Bewusst nie (bis Bedarf bewiesen):** Parallel-Tasks, Agenten-Langzeitgedächtnis, Approval-Gates, MCP-Server, eigener Embedding-Index, Mobile.

---

## 10. Risiken & offene Fragen

**Risiken (mit Mitigation):**
1. **obsidian-kit-Wiederverwendung vs. Review-Sandbox:** LESSONS.md (2026-07-01, vault-rag-Review-Remediation) belegt: `git+https`-npm-Deps brechen die Community-Review **intermittierend** (Sandbox-Clone schlägt fehl → alle Deps fehlen → `obsidian` wird `any` → Massen-`no-unsafe` → Review: Risks). **Entscheidung (bewusste Abweichung von der Kit-git-Dep-Konvention, durch die neuere Lesson gedeckt):** Die vier kleinen Kit-Module werden **ab Commit 1** nach `src/vendor/kit/` vendort (copy-not-share), ebenso der Test-Mock nach `tests/__mocks__/` — jede Datei mit Herkunfts-Header (`vendored from obsidian-kit#0.2.0, <pfad>`). Kit-Updates werden manuell nachgezogen; kein git-Dep, kein später Überraschungs-Swap.
2. **obsidian-git-Auto-Backup mitten im Lauf** kann Agent-Writes in Fremd-Commits ziehen. Mitigation: pfadgenaues Stagen (wir nehmen nie Fremdes mit), Plugin-Detection + einmaliger Hinweis, index.lock-Retry. Echte Lösung (Lock-Konvention/Pausier-API) bleibt offen; Restrisiko akzeptiert, weil Partial-Commits sauber protokolliert sind.
3. **Verschachteltes Pipeline-YAML im Frontmatter vs. Obsidian-Property-Editor** (kann Strukturen still beschädigen). Mitigation: Preflight-Validierung mit präziser Fehlermeldung vor jeder Ausführung, Source-Mode-Empfehlung in der Doku, `version`-Feld. Beobachten; falls es real beißt, wäre ein dedizierter Team-Editor V2+.
4. **Semantisch inkonsistente Teilanwendung** trotz Konsistenz-Schwelle (z. B. 4 von 7 zusammengehörigen Patches). Mitigation: Schwelle + vollständiges Protokoll + Undo pro Lauf; ein `atomic`-Flag pro actions-Task ist als V2-Option notiert, nicht versprochen.
5. **Modellqualität kippt still** (anderes Quant, Modellwechsel): Läufe werden schlechter ohne zu „fehlern". Mitigation: Modell+Kontextlänge in jedem run.md, runs.base macht Drift sichtbar; automatischer Qualitäts-Score wäre Scheingenauigkeit — bewusst weggelassen.
6. **TaskNotes-Schema-Drift:** Enum-Enumeration statt Hardcoding und Feld-Projektion pro Team-Datei federn ab; ein `_types`-Parser (SSOT-Kopplung) bleibt bewusst draußen (V2-Prüfung).
7. **Prompt-Injection über Vault-Inhalte:** gelesene Notes können Instruktionen enthalten. Haltung (aus „vaultux", ehrlich): kein Sanitizing-Versprechen (falsche Sicherheit); der Schaden ist strukturell begrenzt durch write_scope, Quellbindung, Limits, kein Delete, `_crews/**`-Lese-Denylist und Git-Undo. Dokumentieren.
8. **Ein-Lauf-Lock** frustriert bei langen Läufen — akzeptiert für V1 (Determinismus > Durchsatz); Queue wäre V2+. LM Studio bedient ein 35B-Modell ohnehin faktisch seriell.
9. **Kontextfenster-Realität:** Triage/Briefing mit Batch-Limit 25 und Feld-Projektion sind unkritisch; Recherche-Crews (Use-Case 3) sprengen Budgets schnell → bewusst hinter V2, Fail-fast-Budgeter steht.
10. **Vault-Root ≠ Git-Root:** V1 nimmt Repo im Vault-Root an (Pallas: ja); Abweichung → REFUSED mit Meldung; konfigurierbarer Git-Root wäre V2.

**Offene Fragen — am 2026-07-02 entschieden (Design-Freigabe „autonom umsetzen", Empfehlungen übernommen):**
1. **Prompt-Sprache der Beispiel-Crews:** ✅ DE ausliefern (Vault ist deutsch); per Team-Datei trivial änderbar.
2. **Commit-Trailer:** ✅ Vom Plugin erzeugte Lauf-Commits tragen ausschließlich `Crew-Run: <run-id>` — es committet das Plugin zur Laufzeit, nicht ein KI-Entwickler; CORE-GIT-05 gilt nur für Entwicklungs-Commits am Repo selbst.
3. **Daily-Briefing-Kopplung:** ✅ `create_if_missing: false` — „Daily zuerst anlegen" ist akzeptierte Routine; Template-Erzeugung bleibt draußen.
4. **Name `vault-crews`:** ✅ Registry-Check 2026-07-02 gegen `community-plugins.json`: frei (0 Treffer, kein ähnliches „crew"-Plugin).
5. **Triage-Wertemengen:** ✅ V1 Enumeration only; Override-Bedarf beobachten.

---

## 11. Verworfene Alternativen

- **Frei definierbare `output_schema`-DSL in Team-Dateien ab V1 („mvp"):** verworfen zugunsten eingebauter, versionierter Schemata. Zwei Judges werteten die User-DSL als Forever-Kompatibilitätsfläche und Über-Engineering genau dort, wo das schwache Modell ohnehin Chaos liefert. Trade-off (neue Output-Formen brauchen bis V3 ein Plugin-Update) ist bewusst akzeptiert; die Kern-Idee der DSL — die `enum_from`-Quellbindung — wurde als festes Feature der eingebauten Schemata gerettet.
- **Template-Ausdruckssprache mit Feldpfaden/Array-Indexing (`{{task.output.top3[0].path}}`, „vaultux"):** verworfen — eigener Mini-Interpreter mit einer Laufzeit-Fehlerklasse (leere Listen, fehlende Felder), die keine Trocken-Validierung abfangen kann; klassischer Framework-Ballast. Die deklarative `inputs`-Artefakt-Übergabe leistet das Nötige.
- **Prosa-Output-Verträge („Liste von {path, title, grund}", „vaultux"):** verworfen — unvalidierbar, schwächste JSON-Absicherung bei genau dem Modelltyp, der die stärkste braucht.
- **Pipeline als YAML-Block im Note-Body + Wikilink-Agent-Referenzen („vaultux"):** verworfen — fragile Mensch/Maschine-Vermischung (Prosa-Edits brechen Läufe), Link-Resolution koppelt den puren Parser an Vault-Semantik. Frontmatter = Maschine, Body = Doku.
- **Plugin schreibt `last_run`/`last_result` in die Team-Note („vaultux"):** verworfen — Frontmatter-Churn und Konfliktrisiko in einer gleichzeitig User-editierten Datei; Status lebt in `runs/` + data.json.
- **Deutsche/Emoji-Werte als Maschinen-Vokabular und deutsche Default-Ordner („vaultux"):** verworfen — lokalisiertes Maschinen-Schema wäre nur per Datenmigration heilbar; Schema-Keys/Werte englisch-kanonisch, UI via i18n.
- **`_types`-Schema-Parser + `create_task` in V1 („vaultux"):** verworfen — Maschinerie ohne V1-Verbraucher, tiefste Kopplung an persönliche Vault-Konventionen; Slug-Mapping erreicht den Robustheitsgewinn ohne die Kopplung.
- **Gather-Aufrufe innerhalb des LLM-Tasks („mvp") statt eigener collector-Task-Art:** verworfen zugunsten der expliziten Dreiteilung — das lehr- und testbarere mentale Modell mit genau einem Validierungspunkt.
- **Kein Crash-Recovery / Lock nur als Absicht („mvp"):** verworfen — uncommittete Agent-Writes nach einem Obsidian-Crash sind exakt der Zustand, den das Git-Netz-Versprechen ausschließt; Lock-Datei + state.json + Recovery-Dialog sind Pflicht.
- **Statischer 12k-Token-Cap statt modelInfo („mvp") bzw. manuell gepflegtes Kontextfenster in Settings („vaultux"):** verworfen — LM Studio lädt Modelle real mit abweichender Kontextlänge; der Budgeter fragt die Wahrheit ab.
- **Stall-Detektor ab Call-Beginn + 180 s Timeout („robust"):** korrigiert — kollidierte mit der JIT-TTFB-Realität von LM Studio (> 60 s bis zum ersten Token).
- **Hartkodierte 8080-Denylist im Code + Parsen der obsidian-git data.json („robust"):** abgeschwächt zu Default-Setting bzw. reiner Plugin-Detection — benutzerspezifische Umgebungsannahmen und ungetypte Fremd-Config-Kopplung gehören nicht fest in ein Community-Plugin.
- **Settings-Toggles „ohne Git erlauben"/„Läufe immer committen" („robust"):** verworfen — harte Regeln statt Sicherheits-Optionen (weniger Entscheidungslast, keine unsichere Konfiguration möglich).
- **isomorphic-git / obsidian-git-API** (alle drei einig): verworfen — zweite Git-Implementierung bzw. instabile Fremd-API; System-git via child_process ist schnell, korrekt, konventionskonform.
- **Approval-Gates, Resume in V1, natives Tool-Calling in V1, json_schema-Modus:** verworfen per festen User-Entscheidungen bzw. verifizierter LM-Studio-Realität (tool_choice-400 bei Reasoning-Modellen); Idempotenz ersetzt Resume.
