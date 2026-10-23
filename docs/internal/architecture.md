# Architektur von vault-crews

Aufbau und Grenzen des Plugins, zum Nachschlagen. Was beim Arbeiten beißt, steht im Kern der `AGENTS.md` und in `.claude/rules/`; das Warum in `decisions.md`.

## Schichten

- `src/core/` ist rein: kein `obsidian`-Import, Ports werden injiziert (`src/core/ports.ts`). Hier laufen die Pipeline (`orchestrator.ts`: collector → llm → actions), die Pfad-Guards (`paths.ts`), der Executor (`action-executor.ts`), die Validierung (`output-validator.ts`, `schemas.ts`), die Anfrage (`crew-request.ts`), der Lauf-Log (`run-log.ts`) und der Undo-Plan (`undo-plan.ts`).
- `src/obsidian/` sind die Adapter: Vault-Port, Panel, Settings, Snapshot-Store (git-freies Undo), Wiederherstellung nach einem Absturz, Transporte. `src/main.ts` verdrahtet beides.
- `src/vendor/` sind Kopien aus code-kit (`kit/`, rein) und obsidian-kit (`kit/`, `kit-obsidian/`). Nicht von Hand ändern; Pins und Quelle in `src/vendor/kit/VENDOR.json` und `tools/kit-sync.json`.
- `src/i18n/` hält die Wörterbücher (EN und DE).
- Gate `check:pure` bewacht die Reinheit von `src/core`, `src/vendor` und `src/obsidian/panel-view-model.ts`.

## Historische Spezifikation (eingefroren, weiter gültig als Referenz)

Die V1-Design-Grundlagen liegen nicht mehr im Repo: Specs und Pläne liegen im Vault-Cockpit unter `_SDD/` (CORE-META-14), eingefroren, aber als Referenz für Architektur-Entscheidungen weiter gültig; neue SDD-Artefakte gehen ebenfalls dorthin. In dieser Reihenfolge lesen:

1. Spec: `_SDD/2026-07-02-vault-crews-design.md`
2. Interface-Skelett (bindende Pfade/Typen/Signaturen): `_SDD/2026-07-02-vault-crews-v1-interfaces.md`
3. Implementierungsplan (19 Tasks): `_SDD/2026-07-02-vault-crews-v1.md` + Detail-Anhänge `_SDD/tasks-09-11-executor-gitplan-runlog.md` und `_SDD/tasks-14-15-gitport-adapter.md`

## Grenzen von V1

Kurzfassung von README.md „V1 limitations" — bei Rückfragen dort das Detail:

- Kein Mid-Run-Transport-Retry/Endpoint-Re-Resolve (V2) — ein fehlgeschlagener Lauf ist immer sicher (Snapshot + Log) und dank `section.replace`-Idempotenz + Overwrite-Verweigerung billig wiederholbar.
- Crash-Recovery geht von EINEM Gerät aus; zwei gleichzeitig laufende Obsidian-Desktops auf demselben gesyncten Vault sind out of scope (Spec §10 Risiko 8).
- „Fehlerstelle ansehen" öffnet `run.md` am Dateianfang (kein Ephemeral-Scroll zum fehlgeschlagenen Task).
- Endpunkt- und Timeout-Änderungen wirken mit dem nächsten Lauf: `executeRunFor()` baut den `LlmClient` am Start jedes Laufs frisch aus den aktuellen Settings (`buildLlmClient`, `src/main.ts`); ein Plugin-Reload ist nicht nötig (gemessen am Code 2026-09-26, vorher stand hier das Gegenteil).
- Abbruch ist kooperativ (greift an Task-Grenzen + im LLM-Stream). Schnelle Läufe (1–2 s, MoE) können durch sein, bevor der Klick einen Checkpoint trifft → Lauf endet `ok` — das ist *korrekt* (Arbeit war fertig), kein verlorener Klick. Das Panel ist darüber ehrlich (Run-Panel-UI-Überarbeitung, `feat/run-panel-ui`): Statuszeile zeigt „Abbruch angefordert …", und wenn der Lauf zuerst fertig wurde, sagt die Ergebnis-Karte „Lauf war schon fertig, bevor der Abbruch griff — nichts abgebrochen". Bewusst KEIN Mechanismus, der fertig gerechnete Arbeit verwirft.
