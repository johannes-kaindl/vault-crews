# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

## [0.6.0] — 2026-07-12

### Added

- **`output:`-Block für `llm`-Tasks**: parametrisierbare Output-Familien (`frontmatter.set`, `section.write`) mit `allowed_keys`/`max_chars` — das Crew-Output-Vokabular ist damit offen. Die bisherigen `output_schema: triage-v1|briefing-v1` bleiben als Alias byte-identisch gültig.
- `frontmatter.set` unterstützt **Listen-Werte** (z.B. `tags: [arbeit, notiz]`); die Slug-Enum-Prüfung greift je Listen-Element.
- `tasknotes.query` unterstützt `include_content: true` (liefert Notiz-Inhalt für die gelieferten Notizen).
- Zwei neue Beispiel-Crews: **Notiz-Tagger** (generisch, vault-agnostisch) und **Reifegrad-Tagger** (Pallas-Demo) — demonstrieren das `output:`-Vokabular (`frontmatter.set`) mit Inhalt.
- README-Abschnitt „Eigene Crews schreiben" (output:-Syntax, include_content, write_scope).

## [0.5.0] — 2026-07-11

### Added

- `create_if_missing`-Flag für `section.replace`-Tasks in Crews: legt die Zieldatei
  (Marker-Block, kein Template) samt fehlender Elternordner an, statt kontrolliert zu
  failen. Die Daily-Briefing-Beispiel-Crew nutzt es und braucht die heutige Daily Note
  nicht mehr vorab. Undo entfernt die erzeugte Note (Papierkorb).

## [0.4.0] — 2026-07-10

### Added

- Endpoint-Management-UI in den Settings: Zeilen-Editor für Endpunkte (Hinzufügen/Entfernen,
  Per-Zeile-Verbindungsstatus mit Fehlerklassen, aktiv-Marker, nicht-blockierende
  Eingabe-Warnungen, Ein-Klick-Presets für LM Studio und Ollama) und für gesperrte Endpunkte.
- Standardmodell als Dropdown, geladen aus dem aktiven Endpoint (`Modelle laden`), mit
  Freitext-Fallback offline; eine gespeicherte, aktuell nicht gelistete Modell-Auswahl bleibt
  als Option erhalten.

### Changed

- Verbindungstest läuft jetzt pro Endpunkt-Zeile (Live-Status) statt über einen globalen Button.
- `endpoint_diagnostics` (Status-Klassifikation, Presets, Eingabe-Prüfung) aus `obsidian-kit`
  vendored; `endpoint.ts` auf Kit-Stand gehoben (`parseEndpointList`).

## [0.3.0] — 2026-07-08

### Added

- Ollama-Unterstützung ohne Provider-Setting: Kontextlängen-Sonde (`/api/show`),
  provider-übergreifende Thinking-Suppression, CORS-Non-Stream-Fallback,
  Always-on-Thinker-Erkennung (gpt-oss/harmony) mit run.md-Vermerk + Notice.

### Changed

- `LmStudioClient` → `LocalLlmClient` (provider-agnostischer Name).

## [0.2.0] — 2026-07-07

### Changed

- **Git-free snapshot undo.** "Undo last run" no longer relies on the vault being a git
  repository. Before a run writes a note, the plugin snapshots that note's pre-run state
  (copy-on-write, write-ahead) into a hidden store under
  `.obsidian/plugins/vault-crews/undo/<runId>/`, via the Obsidian vault/adapter API only.
  Undo restores changed notes from the snapshot and moves run-created notes to the
  Obsidian trash (never a hard delete). This works in **every** vault, not just git repos.
- **Honest conflict warning.** If a note was edited after the run but before undo (detected
  via content hash), the confirmation dialog warns before rolling it back — never a silent
  overwrite.
- **New setting "Undo history depth"** (default 15) controls how many recent runs keep an
  undo snapshot; older snapshots are pruned automatically.

### Removed

- **All `child_process` and `node:fs` usage.** The git-backed undo (system `git commit` /
  `git revert`) is gone, so the plugin no longer performs shell execution or direct
  filesystem access — removing both Community-store review "Behavior" warnings. Vaults that
  want a permanent versioned history can still run git themselves; the run logs
  (`run.md`) remain the durable human-readable record.

## [0.1.0] — 2026-07-06

### Added

- **Deterministic crew pipeline.** A crew ("team") runs as a fixed sequence of three
  task kinds — `collector` (deterministic context gathering), `llm` (one schema-bound
  chat completion), `actions` (deterministic application of a validated action list).
  The model decides *content* only, inside narrow contracts; the orchestrator decides
  flow, paths and writes.
- **Constrain-then-verify before every write.** Every LLM output is extracted,
  validated against a built-in versioned schema, and source-bound (no invented paths or
  enum values), with a one-shot repair pass for malformed JSON.
- **One git commit per run with one-click undo.** Every run — ok, partial, failed or
  aborted — ends in exactly one commit covering only the files it touched plus its run
  log. Undo survives a dirty working tree (stash-wrapped `git revert`).
- **Run panel with hub navigation.** A single view with internal tabs (Crews · History),
  a persistent status line carrying the one cancel button, and honest cooperative-abort
  feedback (a run that finished before the abort landed says so rather than freezing).
- **Two shipped example crews**, installable via a command: Task-Triage and
  Daily-Briefing.
- **Full in-vault observability.** Each run writes a human-readable `run.md` (Bases-
  compatible) and a machine-readable state file.
- **Local-model-aware LM Studio client** — context length probing, thinking suppression,
  JIT stall timeout, ordered endpoint fallback.
