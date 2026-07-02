# AGENTS.md

Conventions for AI assistants working in this repo.

## What this is
Obsidian-Plugin **Vault Crews** (`vault-crews`): autonome lokale LLM-Agenten-Teams
(LM Studio, `localhost:1234`) laufen als deterministische Pipelines auf dem Vault —
collector → llm → actions, constrain-then-verify, ein Git-Commit pro Lauf.

## Verbindliche Quellen (in dieser Reihenfolge lesen)
1. Spec: `docs/superpowers/specs/2026-07-02-vault-crews-design.md`
2. Interface-Skelett (bindende Pfade/Typen/Signaturen): `docs/superpowers/plans/2026-07-02-vault-crews-v1-interfaces.md`
3. Implementierungsplan (19 Tasks): `docs/superpowers/plans/2026-07-02-vault-crews-v1.md`
   + Detail-Anhänge unter `docs/superpowers/plans/details/`

## Workflow conventions
- **Gate (vor jedem Commit grün):** `npm run gate` = lint + typecheck + test + check:pure.
  Exit-Code prüfen, nicht grep-Ausgabe (grep maskiert Fehlschläge).
- **Tests:** Vitest node-env; Obsidian-Mock via vitest `resolve.alias` →
  `tests/__mocks__/obsidian.ts`. TDD: erst fehlschlagender Test.
- **Commit style:** Conventional Commits + Trailer
  `Co-Authored-By: <Modell> <noreply@anthropic.com>`.
- **Deploy:** `npm run deploy` (Copy nach `$OBSIDIAN_PLUGIN_DIR`), nie Symlink/BRAT als Primärweg.

## Architecture notes (Invarianten + Gotchas)
- `src/core/**` und `src/vendor/**` importieren NIE `obsidian` (CI-Gate `check:pure`).
  Ports injiziert (`src/core/ports.ts`); Obsidian-Adapter nur in `src/obsidian/`.
- **Vendoring statt git-Deps:** obsidian-kit-Module liegen kopiert in `src/vendor/kit/`
  mit Herkunfts-Header (`vendored from obsidian-kit#0.2.0, <pfad>`). KEINE
  `git+https`-npm-Dependencies — die Community-Review-Sandbox bricht daran
  (LESSONS.md 2026-07-01). Updates manuell nachziehen; Smoke-Tests in
  `tests/vendor/kit.test.ts` pinnen die Verträge.
- **Slug-Schnitt:** `Schema.validate` prüft Slugs und lässt sie stehen;
  das byte-genaue Rück-Mapping auf Emoji-Originale macht der ActionExecutor
  (`ExecutorContext.slugTables`, Stufe-2-Verteidigung).
- **Denylist:** `buildDenylist(configDir)` — configDir wird injiziert
  (`Vault#configDir`, obsidianmd-Lint). `**/.*/**` deckt Inhalte unter
  Dot-Ordnern (Property-Test-Fund).
- **LM Studio:** Kontextlänge aus `/api/v0/models`
  (`loaded_context_length ?? max_context_length`); Thinking-Suppression via
  `reasoning_effort: "none"` + `chat_template_kwargs.enable_thinking: false`;
  Stall-Timeout erst NACH erstem Token (JIT-TTFB). NIE Port 8080 als Backend
  (OpenClaw-Mono-Consumer-Lock).
- **Kein `json_schema`-API-Modus** (bricht an LM Studio bei Reasoning-Modellen):
  prompt-basiertes JSON + `output-validator`.

## Memory + logs
- **Memory** (cross-session): `~/.claude/projects/-Users-johannes-Workspace/memory/`
  (Zeiger auf Cockpit); operativer Stand im Coding-Cockpit
  `/Users/Shared/10_ObsidianVaults/10_Pallas/25_Coding/vault-crews/vault-crews.md`.
- **Session logs:** Cockpit-`_Log/` (SessionEnd-Hook) + remember-Plugin.
