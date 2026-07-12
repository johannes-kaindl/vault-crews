# Listen-Werte in `frontmatter.set`

**Datum:** 2026-07-12
**Status:** Design (approved)
**Scope:** Release-Blocker-Fix vor 0.6.0. `frontmatter.set` (und der `frontmatter.patch`-
Ausführungspfad) unterstützt neben skalaren Werten auch **Listen-Werte**, damit der
Notiz-Tagger `tags` als Liste schreiben kann. Aus dem 0.6.0-Smoke: der Notiz-Tagger
konnte bislang gar nicht schreiben, weil `frontmatter.set` Array-Werte als
„unzulässiger Werttyp" ablehnte.

## Problem

Der Live-Smoke deckte auf: `frontmatter.set` (auf `triageV1.validate` basierend) und der
gesamte `frontmatter.patch`-Pfad sind auf **skalare** Werte typisiert
(`Record<string, string | number | null>` in `FrontmatterPatchAction.set`, `mappedSet`,
`patchFrontmatter`). Ein Multi-Value-Feld wie `tags: [a, b, c]` — in Obsidian die Norm —
wird bei der Validierung abgewiesen (`schemas.ts` „unzulässiger Werttyp"). Der
Notiz-Tagger ist damit unabhängig vom Modell **nicht lauffähig** wie beabsichtigt.

(Der Smoke scheiterte zuerst am Modell-Output — kein JSON / HTTP 400 —, sodass der
Array-Fall gar nicht erreicht wurde. Modell-Robustheit ist ein separates Thema, s.
Nicht-Ziele.)

## Nicht-Ziele (YAGNI)

- **Keine Modell-Robustheit-Fixes.** HTTP-400-Fehlklassifikation (`endpoint_unreachable`),
  abgeschnittener Fehler-Log, thinking-Suppression für Always-on-Thinker (ornith) →
  gehören ins spätere Run-Robustheit-/UX-Paket, nicht hierher.
- **Keine verschachtelten Strukturen.** Listen enthalten nur Skalare (`string`/`number`);
  keine Objekte, keine Listen-in-Listen, kein `null` als Listen-Element.
- **Keine neue Familie / kein neues Vokabular.** Nur der Werttyp von `frontmatter.set`
  wird von „Skalar" auf „Skalar oder Liste-von-Skalaren" erweitert.

## Design

### Werttyp

Neuer geteilter Typ (in `types.ts`):
```ts
export type FmScalar = string | number | null;
export type FmValue = FmScalar | (string | number)[];   // Liste ohne null-Elemente
```
`FmValue` ersetzt `string | number | null` in `FrontmatterPatchAction.set`, in
`ValidatedAction.mappedSet` (`action-executor.ts`) und in der `patchFrontmatter`-Port-
Signatur (`ports.ts`, `vault-port.ts`). **Skalare bleiben unverändert** → voll
rückwärtskompatibel (triage-v1, task-triage, alle bestehenden Läufe).

### Validierung (`schemas.ts` `makeFrontmatterSet`)

Im Per-Key-Loop kommt vor dem heutigen Skalar-Zweig ein **Array-Zweig** hinzu:
- Ist `rawValue` ein Array: jedes Element **einzeln** prüfen.
  - Enum-Feld (SlugTable vorhanden): jedes Element muss ein String und in `table.fromSlug`
    sein, sonst Fehler (Werte bleiben Slugs — Rückmapping Stufe 2 im Executor, wie bei
    Skalaren).
  - Sonst: jedes Element muss `string` oder `number` sein; `null`/Objekt/verschachtelt →
    Fehler `items[i].set.<key>: unzulässiges Listen-Element`.
  - Leere Liste `[]` ist erlaubt (schreibt eine leere Liste; kein Sonderfall).
- Der **Skalar-Zweig bleibt wortgleich** zum heutigen Code.

Die Sicherheitsinvarianten gelten damit **pro Element**: Source-Binding (am Pfad,
unverändert), Slug-Enum je Listenwert.

### Executor (`action-executor.ts`)

Der frontmatter.patch-Zweig (Slug-Rückmapping + `maxNoteBytes`-Check, heute pro Skalar)
behandelt Arrays elementweise: jedes String-Element wird über die SlugTable zurückgemappt
(falls Tabelle da) und gegen `maxNoteBytes` geprüft; Zahlen/das Array-Gerüst bleiben. Der
Skalar-Pfad bleibt unverändert.

### Schreibpfad (`vault-port.ts`)

`patchFrontmatter` → `app.fileManager.processFrontMatter` serialisiert Listen bereits
korrekt als YAML-Arrays. Nur die **Typ-Signatur** wird auf `FmValue` gehoben; keine
Logik-Änderung.

### Prompt-Hilfe

- `schemas.ts` `frontmatter.set`-**`outputExample`** bekommt ein Listen-Feld, z.B.
  `{"items": [{"path": "…", "set": {"priority": "mittel", "tags": ["arbeit", "notiz"]}}]}`
  — zeigt dem Modell Skalar UND Liste.
- **Notiz-Tagger** (`example-assets.ts` + Disk-Spiegel): `instruction`/Agent stellt klar,
  dass `tags` als **Liste** geliefert werden. (byte-identisch TS ↔ Disk.)

## Betroffene Module

- `src/core/types.ts` — `FmScalar`/`FmValue`, `FrontmatterPatchAction.set`.
- `src/core/schemas.ts` — Array-Zweig in `makeFrontmatterSet.validate`; `outputExample`.
- `src/core/action-executor.ts` — `mappedSet`-Typ + elementweises Rückmapping/Byte-Check.
- `src/core/ports.ts` — `patchFrontmatter`-Signatur.
- `src/obsidian/vault-port.ts` — `patchFrontmatter`-Signatur (nur Typ).
- `src/obsidian/example-assets.ts` + `assets/examples/…/notiz-tagger.md` — instruction/Agent.

## Testing

- `tests/core/schemas.test.ts` — `frontmatter.set` akzeptiert String-Liste; Enum-Feld
  prüft jedes Element (ein ungültiges Element → Fehler); `null`/Objekt-Element abgelehnt;
  Skalar-Verhalten unverändert (Regression).
- `tests/core/action-executor.test.ts` — Slug-Rückmapping über eine Liste; `maxNoteBytes`
  greift pro Element; Skalar-Pfad unverändert.
- `tests/obsidian/install-examples.test.ts` — Notiz-Tagger parst weiter `ok:true`;
  byte-Identität der geänderten Crew.
- `npm run gate` grün (lint + typecheck + test + check:pure) vor jedem Commit.

## Danach

Re-Smoke (Handover aktualisieren, inkl. Hinweis auf ein JSON-fähiges Modell mit
funktionierender thinking-Suppression) → grün → Release 0.6.0. Robustheit-/UX-Paket
separat.
