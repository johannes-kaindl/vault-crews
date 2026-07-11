# `create_if_missing` für `section.replace`

**Datum:** 2026-07-11
**Status:** Design (approved)
**Scope:** Ein neues Task-Level-Flag, das `section.replace` erlaubt, ein fehlendes Ziel anzulegen statt kontrolliert zu failen.

## Problem

`section.replace` schlägt heute kontrolliert fehl, wenn die Zieldatei nicht
existiert (`action-executor.ts:143-146`, Outcome `failed` mit Meldung „… zuerst
anlegen (create_if_missing: false)"). Das war die bewusste V1-Entscheidung
(Spec 2026-07-02 §4.3, Design-Entscheidung 3: „create_if_missing: false —
'Daily zuerst anlegen' ist akzeptierte Routine"). Die Daily-Briefing-Beispiel-Crew
verlangt deshalb, dass die heutige Daily Note vorher existiert, und ihr Prompt
enthält den Hinweis „lege die heutige Daily Note vorher an".

Wir wollen den in der Ur-Spec bereits vorgesehenen Parameter `create_if_missing`
tatsächlich verdrahten (`true`-Fall), damit eine Crew das Ziel selbst anlegen kann.

## Nicht-Ziele (YAGNI)

- **Kein `note.append`-Support.** Kein Builtin-Schema erzeugt `note.append`, und
  Append-unter-Heading auf einer frischen (leeren) Datei ist sinnlos. Der Flag
  wirkt ausschließlich auf `section.replace`.
- **Kein Template.** Die erzeugte Datei enthält nur den Crew-Marker-Block, keine
  Daily-Template-Struktur (Spec-Linie 2026-07-02 §11: „Template-Erzeugung bleibt
  draußen").
- **Kein Flag auf Action-/Schema-Ebene.** Der Flag ist Policy, nicht Inhalt — der
  LLM entscheidet ihn nicht. Er lebt task-lokal und wird NICHT auf die
  Action-Typen oder in die Schema-`validate()` gefädelt.
- **Kein Ordner-Undo.** Der Snapshot-Store trackt nur Dateien. Ein durch den Lauf
  via `mkdir` erzeugter leerer Elternordner bleibt nach Undo stehen (harmlos,
  dokumentierte Limitation).

## Design

Task-Level-Flag `createIfMissing` auf `ActionsTaskDef`, aus der Crew-Markdown
geparst, im Executor über den bereits vorhandenen `ctx.task` gelesen. Vier
Andockpunkte:

| # | Datei | Änderung |
|---|-------|----------|
| 1 | `src/core/types.ts` | `ActionsTaskDef` erhält `createIfMissing: boolean` |
| 2 | `src/core/crew-parser.ts` | `create_if_missing` aus dem actions-Task-Rohobjekt parsen (Default `false`, Typ-Check auf boolean) |
| 3 | `src/core/action-executor.ts` (`validateAction`) | `section.replace`: fehlendes Ziel + `ctx.task.createIfMissing === true` → **nicht** failen, Aktion bleibt gültig |
| 4 | `src/core/action-executor.ts` (`applyAction`) | `section.replace`: Datei fehlt → Elternordner via `vault.mkdir` sicherstellen, dann `vault.create(path, replaceSection('', ctx.team.id, content))` statt `read`+`modify` |

### Crew-Syntax

Im actions-Task, neben `allowed_actions`/`target`/`allowed_keys`:

```yaml
create_if_missing: true
```

Fehlt der Schlüssel → `false` (Default; bestehende Crews unverändert). Nicht-boolean
→ Parser-Fehler mit klarer Meldung (wie bei anderen Task-Feldern).

### Executor-Verhalten (`section.replace`)

**Validierung** (`validateAction`), heutiger Block `action-executor.ts:142-155`:

- Ziel existiert nicht **und** `ctx.task.createIfMissing !== true` → wie bisher
  Outcome `failed` („… zuerst anlegen").
- Ziel existiert nicht **und** `ctx.task.createIfMissing === true` → **kein**
  Fail; die Aktion durchläuft die restlichen Checks (Marker-Injection,
  `maxNoteBytes`). Der Stale-Guard (Schritt 5) greift nicht, weil eine
  nicht-existente Datei nicht in `ctx.sources` liegt.

**Apply** (`applyAction`), heutiger Block `action-executor.ts:222-224`:

- Datei existiert → wie bisher `read` + `modify(replaceSection(current, …))`.
- Datei existiert nicht → Elternordner sicherstellen
  (`await vault.mkdir(parentDir)` wenn `parentDir` nicht leer und nicht vorhanden;
  `mkdir` ist idempotent), dann
  `await vault.create(path, replaceSection('', ctx.team.id, content))`.
  `replaceSection('', teamId, content)` erzeugt den Marker-Block ohne Sonderpfad
  (bestehende Logik, `action-executor.ts` `replaceSection` mit `current === ''`).

### Undo (automatisch, keine Änderung nötig)

`preWrite` (`orchestrator.ts:310-314`) berechnet `existedBefore` live vor jedem
Write. Für die neu erzeugte Datei ist `existedBefore === false` → der Snapshot
kennt sie als „nicht vorher da" → `buildUndoPlan` legt sie in `deletes`
(Papierkorb via `fileManager.trashFile`, `undo-plan.ts`). Die
maxWrites-Budgetierung und die >50%-Konsistenz-Schwelle sind unberührt: die
create-if-missing-Aktion wird jetzt `applied` statt `failed`, zählt also als ein
regulärer Write.

## Beispiel-Crew

Die Daily-Briefing-Crew (`src/obsidian/example-assets.ts`) wird auf
`create_if_missing: true` umgestellt; der Prompt-/Kommentar-Hinweis „lege die
Daily vorher an" (Zeilen ~147-152) entfällt bzw. wird angepasst. Damit läuft die
Beispiel-Crew ohne vorher angelegte Daily Note durch.

## Definition of Done

- [ ] `ActionsTaskDef.createIfMissing: boolean` (Default via Parser `false`).
- [ ] `crew-parser` parst `create_if_missing` (boolean, Default `false`, Typ-Fehler bei Nicht-boolean).
- [ ] `section.replace` mit fehlendem Ziel: ohne Flag weiterhin `failed`; mit Flag → Datei wird angelegt (Marker-Block), Aktion `applied`.
- [ ] Nested Zielpfad: fehlender Elternordner wird via `mkdir` angelegt.
- [ ] Undo trasht die erzeugte Datei (bestehende Snapshot-Logik, Test bestätigt).
- [ ] Daily-Briefing-Beispiel-Crew nutzt `create_if_missing: true`, Prompt-Hinweis angepasst.
- [ ] CHANGELOG `[Unreleased]` dokumentiert das Feature (user-facing).
- [ ] `npm run gate` grün (lint + typecheck + test + check:pure), Exit-Code geprüft.
