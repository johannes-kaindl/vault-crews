# AGENTS.md

Conventions for AI assistants working in this repo.

> **Workspace-Standards (maintainer-lokal):** Die verbindliche Leitkonvention steht in `_docs/CONVENTIONS.md` im Multi-Projekt-Workspace des Maintainers, `../../workspace/_docs` relativ zu diesem Repo — nicht Teil dieses Repos, ignorieren falls im Klon nicht vorhanden. Modell comply-or-explain.

## Project character

Obsidian-Plugin **Vault Crews** (`vault-crews`): autonome lokale LLM-Agenten-Teams (LM Studio, `localhost:1234`) laufen als deterministische Pipelines auf dem Vault — collector → llm → actions, constrain-then-verify, ein git-freies Snapshot-Undo pro Lauf (write-ahead Pre-Images über die Vault-/Adapter-API, kein `child_process`/`node:fs`).

## Architecture principles

- `src/core/**` und `src/vendor/**` importieren NIE `obsidian` (CI-Gate `check:pure`). Ports injiziert (`src/core/ports.ts`); Obsidian-Adapter nur in `src/obsidian/`.
- **Vendoring statt git-Deps:** obsidian-kit- und code-kit-Module liegen kopiert in `src/vendor/` mit Herkunfts-Header, nie von Hand ändern. KEINE `git+https`-npm-Dependencies — die Community-Review-Sandbox bricht daran (Lesson 2026-07-01, `docs/internal/decisions.md`). Updates mit `node ../tools/kit-sync/kit-sync.mjs` (Pins in `tools/kit-sync.json`); Smoke-Tests in `tests/vendor/kit.test.ts` pinnen die Verträge.
- **Schlüssel dürfen nie in den Vault:** `redactKeysInValue` (Kit `redact`, code-kit 0.18.0; die plugin-eigene `src/core/redact.ts` ist seit Welle 16 weg) läuft an genau einer Stelle (`persist()` im Orchestrator, bevor run.md/state.json geschrieben werden). Wer eine neue Ausgabe hinzufügt, die Text aus dem Netzweg trägt, muss durch dieselbe Stelle. Die Kit-Funktion wirft fail-closed (Zirkel, BigInt, kein JSON-Abbild): `persist()` macht daraus `RedactionFailed`, `run()` beendet den Lauf als `failed`/`io` ohne weiteres `persist()` und gibt den Lock frei.
- **API-Schlüssel kommen aus dem Schlüsselbund, und jede Stelle, die `apiKey` braucht, liest `VaultCrewsPlugin.localEndpoints()` (`prepareLocalEndpoints`), nie `settings.endpoints`.** In `data.json` steht nur `secretId`. Wer die rohe Liste an Ping, Client oder die Schwärzung gibt, verliert den Schlüssel still: der Aufruf geht ohne Authorization-Kopf raus, und die Schwärzung maskiert ihn in `run.md`/`state.json` nicht mehr (gemessen: Treiberpunkt „401-Body“, Mutationsprobe Welle 15). Zeilen aus dem Settings-Editor bekommen ihren Schlüssel über `withKey()`.
- **Slug-Schnitt:** `Schema.validate` prüft Slugs und lässt sie stehen; das byte-genaue Rück-Mapping auf Emoji-Originale macht der ActionExecutor (`ExecutorContext.slugTables`, Stufe-2-Verteidigung).

## Commands

- **Gate (vor jedem Commit grün):** `npm run gate` = lint + typecheck (Quelle, Tests, Skripte) + test + check:pure + check:bundle. Exit-Code prüfen, nicht grep-Ausgabe (grep maskiert Fehlschläge).
- **Tests:** Vitest node-env; Obsidian-Mock via vitest `resolve.alias` → `tests/__mocks__/obsidian.ts` (Re-Export des gevendorten Kit-Mocks `tests/vendor/kit/obsidian-mock.ts`; ein Test, der `app.secretStorage` nicht haben soll, löscht es in seinem Plugin-Fake). TDD: erst fehlschlagender Test.
- **Deploy:** `npm run deploy` (Copy nach `$OBSIDIAN_PLUGIN_DIR`), nie Symlink/BRAT als Primärweg.
- **GUI-Smoke:** `npm run smoke:gui -- --vault vault-crews --port <port> [--ohne-modell]` gegen eine Zweitinstanz; Rezept im Kopf von `scripts/gui-smoke.ts`, Checkliste und Handteil in `docs/SMOKE.md`, Wegwerf-Klon eines Vaults mit `scripts/clone-vault.sh`.

## Conventions

- **Commit style:** Conventional Commits + Trailer `Co-Authored-By: <Modell> <noreply@anthropic.com>`.
- **Nie im Repo:** absolute Pfade außerhalb des Repos (`/Users/…`, Vault-Pfade) — Platzhalter nutzen (`$VAULT/…`, `~/…`, repo-relativ). Herkunftsnachweise als Repo-Name + `Datei:Zeile` sind dagegen erwünscht. Gate: `scripts/check-no-abs-paths.mjs` (Teil von `npm test`).

## Gotchas

- **Denylist:** `buildDenylist(configDir, crewRoot)` — configDir wird injiziert (`Vault#configDir`, obsidianmd-Lint). `**/.*/**` deckt Inhalte unter Dot-Ordnern (Property-Test-Fund). `isDenied` prüft den Rohpfad UND `filesystemPath(pfad)` (Kit `folder-scope`), die Muster nach denselben Segment-Regeln: `_crews /x.md`, `_crews./x.md`, `_crews:s/x.md` und `_CREWS/x.md` sind dieselbe Datei wie `_crews/x.md` (Welle 25). Die Whitelist `write_scope` bleibt beim Text, nur wird der Glob beim Einlesen normalisiert gespeichert (Kit `rel-path`, wie `normalizeVaultPath` den Pfad der Aktion).
- **Kein `json_schema`-API-Modus** (bricht an LM Studio bei Reasoning-Modellen): prompt-basiertes JSON + `output-validator`.
- **Nie Port 8080 als Backend** (OpenClaw-Mono-Consumer-Lock).

## Context index

- Bevor du Statusklassen, Fehlerklassen (`ErrorKind`) oder Wörterbuch-Schlüssel an `t()` anschließt: `.claude/rules/statustexte-und-fehlerklassen.md`.
- Bevor du den Modellaufruf, die Anfrage, den Chat-Client, das Streaming oder `finishReason` änderst: `.claude/rules/anfrage-und-chat-client.md`.
- Bevor du Endpunkt-Einträge, die Modellwahl oder den Zeilen-Editor änderst: `.claude/rules/endpunkte-und-schluessel.md`.
- Bevor du den Settings-Tab (`getSettingDefinitions`, Walker-Fallback) änderst: `.claude/rules/settings-tab.md`.
- Vor Änderungen an Schichten, Laufstart, Abbruch oder Crash-Recovery und für die eingefrorene V1-Spezifikation: `docs/internal/architecture.md`.
- Bevor du eine Altentscheidung übernimmst (Vendoring, Statusklassen-Naht, `json_schema`): `docs/internal/decisions.md`.
- Vor einem GUI-Smoke oder dem manuellen Release-Smoke: `docs/SMOKE.md`; Obsidian-Instanz, Lock, Treiber und Staging-Vaults stehen als Pfadregeln im Dach unter `../.claude/rules/`.

## Memory

- **SDD-Artefakte (seit 2026-07-16): Cockpit, nicht Repo** — Specs/Plans/Task-Reports leben im Coding-Cockpit des Maintainers (`$VAULT/25_Coding/vault-crews/_SDD/`, CORE-META-14, maintainer-lokal). Sie tragen Arbeitskontext (Vault-Pfade, Schwester-Repo-Interna), der in einem public Repo niemandem nützt. Das Repo behält die Design-Essenz in `docs/internal/` + `CHANGELOG.md`. Im Repo wird nichts unter `docs/superpowers/` abgelegt (der Altbestand liegt im Cockpit).
- **Memory** (cross-session): `~/.claude/projects/<slug>/memory/`; operativer Stand im Coding-Cockpit `$VAULT/25_Coding/vault-crews/vault-crews.md` (maintainer-lokal).
- **Session logs:** Cockpit-`_Log/` (SessionEnd-Hook) + remember-Plugin.

## Abweichungen von der Leitkonvention

Keine.
