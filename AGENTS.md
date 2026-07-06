# AGENTS.md

Conventions for AI assistants working in this repo.

## What this is
Obsidian-Plugin **Vault Crews** (`vault-crews`): autonome lokale LLM-Agenten-Teams
(LM Studio, `localhost:1234`) laufen als deterministische Pipelines auf dem Vault —
collector → llm → actions, constrain-then-verify, ein git-freies Snapshot-Undo pro Lauf
(write-ahead Pre-Images über die Vault-/Adapter-API, kein `child_process`/`node:fs`).

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

## Smoke checklist
Manueller Release-Smoke-Test (Spec §8: „Kein Live-LLM in CI" — dies ist das
Gate danach). Läuft **immer** gegen einen Wegwerf-Klon, **nie** gegen den
echten Vault — `scripts/clone-vault.sh` schreibt/löscht nie im Quell-Vault.
Der Klon muss **kein git-Repo** mehr sein (Snapshot-Undo, 0.2.0).

1. `scripts/clone-vault.sh` (Default: Pallas → `/tmp/vault-crews-smoke`;
   Quelle/Ziel optional als Argumente).
2. Klon in Obsidian öffnen; Plugin-Build hineinkopieren
   (`OBSIDIAN_PLUGIN_DIR=<Klon>/.obsidian/plugins/vault-crews npm run deploy`)
   oder per BRAT gegen den Klon installieren.
3. Command **„Install example crews"** ausführen.
4. **BEIDE** Beispiel-Crews laufen lassen (Task-Triage **und** Daily-Briefing —
   nicht nur eine).
5. **Undo** testen (Panel → Verlauf → Rückgängig): geänderte Notes wieder im
   Vorzustand, vom Lauf erzeugte Notes im Papierkorb. Der Snapshot-Ordner
   `.obsidian/plugins/vault-crews/undo/<runId>/` existiert nach dem Lauf und
   verschwindet nach dem Undo. Zusatz: eine Note **nach** dem Lauf manuell
   editieren, dann Undo → Konfliktwarnung erscheint.
6. „Abort current run" **mitten in einem Lauf** auslösen — Partial bleibt im
   Vault (undo-bar), run.md zeigt `status: aborted` + `error_kind: aborted`.

## V1 limitations
Kurzfassung von README.md „V1 limitations" — bei Rückfragen dort das Detail:
- Kein Mid-Run-Transport-Retry/Endpoint-Re-Resolve (V2) — ein fehlgeschlagener
  Lauf ist immer sicher (Commit + Log) und dank `section.replace`-Idempotenz +
  Overwrite-Verweigerung billig wiederholbar.
- Crash-Recovery geht von EINEM Gerät aus; zwei gleichzeitig laufende
  Obsidian-Desktops auf demselben gesyncten Vault sind out of scope (Spec §10
  Risiko 8).
- `verboseLogging` (Settings → Advanced) ist reserviert, aber noch nicht
  verdrahtet — nichts liest den Wert.
- „Fehlerstelle ansehen" öffnet `run.md` am Dateianfang (kein Ephemeral-Scroll
  zum fehlgeschlagenen Task).
- Ports (LLM-Endpoint, Timeouts) werden einmalig in `onload()` gebaut —
  Endpoint-/Timeout-Änderungen in den Settings brauchen Plugin-Reload
  (deaktivieren/aktivieren oder Obsidian-Neustart).
- Abbruch ist kooperativ (greift an Task-Grenzen + im LLM-Stream). Schnelle Läufe
  (1–2 s, MoE) können durch sein, bevor der Klick einen Checkpoint trifft → Lauf endet
  `ok` — das ist *korrekt* (Arbeit war fertig), kein verlorener Klick. Das Panel ist
  darüber ehrlich (Run-Panel-UI-Überarbeitung, `feat/run-panel-ui`): Statuszeile zeigt
  „Abbruch angefordert …", und wenn der Lauf zuerst fertig wurde, sagt die Ergebnis-Karte
  „Lauf war schon fertig, bevor der Abbruch griff — nichts abgebrochen". Bewusst KEIN
  Mechanismus, der fertig gerechnete Arbeit verwirft.

## Dach-Kontext (obsidian-plugins)

Dieses Repo liegt unter dem Koordinations-Dach `/Users/Shared/code/obsidian-plugins/`.
**Vor dem Lösen eines Problems:** `../AGENTS.md` (Kit-first-Regel) und `../REGISTRY.md`
(Lösungs-Registry) prüfen — viele Probleme sind in Nachbar-Plugins oder im
`obsidian-kit` bereits gelöst.

**Vor jeder UI-Arbeit** (Views, Modals, Settings-Tabs, CSS): `../UI-STANDARD.md` ist
verbindlich (Obsidian-nativ first, ein Frontend pro Plugin, nur Theme-CSS-Variablen).
