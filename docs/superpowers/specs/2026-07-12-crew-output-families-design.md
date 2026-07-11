# Parametrisierbare Output-Schema-Familien

**Datum:** 2026-07-12
**Status:** Design (approved)
**Scope:** Das Output-Vokabular von Crews öffnen — die zwei fest verdrahteten
Schemas (`triage-v1`, `briefing-v1`) werden zu Spezialfällen zweier generischer,
**vom User parametrisierbarer** Schema-Familien. Erster Schritt einer dreiteiligen
Roadmap „Crew-Vorlagen / Authoring".

## Roadmap-Kontext

„Crew-Vorlagen / Authoring" zerfällt in drei aufeinander aufbauende Teilprojekte,
in dieser Reihenfolge (jeweils eigener Spec → Plan → Impl-Zyklus):

1. **Vokabular öffnen** (dieses Dokument) — der Enabler. Ohne eigene Output-Formen
   wären mehr Vorlagen und ein Authoring-UI strukturell auf `triage-v1`/`briefing-v1`
   gedeckelt.
2. **Vorlagen (Content)** — reiche Beispiel-Crews, die das neue Vokabular
   demonstrieren; zugleich lebende Doku + Lückentest.
3. **Authoring-UX** — In-Plugin-Erstellung/Validierung; teuerstes Stück, profitiert
   davon, erst zu wissen, was Leute bauen.

## Problem

Ein `llm`-Task muss heute eines von genau **zwei** fest eingebauten Output-Schemas
produzieren (`SchemaId = 'triage-v1' | 'briefing-v1'`, `types.ts:15`). Jede neue
Crew, deren Output nicht Task-Triage oder ein Briefing ist, braucht **neuen
Plugin-Code** (ein weiteres `SchemaDef` in `schemas.ts` + Registry-Eintrag). Damit
ist selbstgebautes Crew-Authoring auf zwei Anwendungsfälle begrenzt.

Die Beobachtung, die die Lösung trägt: Die beiden Schemas sind bereits *fast*
generisch. `triage-v1` schreibt source-gebundene Frontmatter-Patches; `briefing-v1`
schreibt einen Freitext per `section.replace` ins Ziel — sein „Drei-Abschnitte"-
Format kommt ausschließlich aus der `instruction`/dem Agent-Prompt, **nicht** aus
dem Schema. Es fehlt nur die Parametrisierung.

## Sicherheitskern (die Invariante, die NICHT fallen darf)

Ein Schema ist kein Datenformat, sondern **Code**: `SchemaDef.validate(json,
sources, slugTables, target) → Action[]` ist der *eine* Übergabepunkt, der drei
Invarianten erzwingt und dann die deterministische Aktionsliste erzeugt
(`schemas.ts`):

1. **Source-Binding** — jeder Pfad muss im Quellmaterial vorkommen
   (`knownPaths.has(path)`) → Pfad-Halluzination strukturell unmöglich.
2. **Slug-Enums** — Frontmatter-Werte müssen aus der erlaubten `slugTables`-Menge
   stammen.
3. **Constrain → Action** — nur `validate()` erzeugt `Action[]`; der Executor
   erzeugt nie selbst Aktionen und wendet danach unverändert Write-Scope, Denylist
   und `max_writes` an.

`schemas.ts` hält deshalb bewusst fest: „KEINE user-definierbare Schema-DSL in V1
und kein Ajv (eval-Compile)". Dieses Design **respektiert** das: Familien sind
eingebauter `validate()`-Code, den nur **deklarative Wertelisten/Zahlen** steuern —
kein User-Code, kein `eval`, kein Ajv.

## Nicht-Ziele (YAGNI)

- **Keine Schema-DSL.** Familien-Parameter sind reine Wertelisten (`allowed_keys`)
  oder Zahlen (`max_chars`). Sobald ein Parameter Logik/Bedingungen/berechnete Werte
  trüge, wäre das die zurückgestellte DSL — ausdrücklich draußen.
- **Keine neuen Collectors/Actions.** Nur das Output-Vokabular (Schemas) wird
  geöffnet — das echte Nadelöhr (2 Schemas vs. 3 Collectors / 4 Actions). Mehr
  Collectors/Actions kommen separat, wenn eine konkrete Crew sie braucht.
- **Keine wiederverwechselbaren Schema-Notes.** Die Parametrisierung lebt **inline**
  am `llm`-Task, nicht in einer eigenen `crew-kind: schema`-Datei. Wiederverwendung
  über Teams ist bislang kein belegter Bedarf; kein neuer Datei-Typ + Discovery.
- **Keine Migration der Beispiel-Crews.** `task-triage`/`daily-briefing` bleiben in
  diesem Teilprojekt unverändert (über die Aliase) — das ist der Rückwärtskompat-
  Beweis. Die Familien werden erst in Teilprojekt 2 vorgeführt.
- **Kein Release.** Ohne Demo-Vorlagen ist die Syntax für Nutzer noch nicht sichtbar
  wertvoll → mit Teilprojekt 2 gebündelt (Release-Hygiene, vgl. Chat-Response-Split).

## Design

### Zwei Familien

| Familie | Verallgemeinert | Parameter | `validate()`-Verhalten |
|---|---|---|---|
| `frontmatter.set` | `triage-v1` | `allowed_keys: string[]` | Wie `triage-v1` (Source-Binding + Slug-Enums), **plus** ein Gate: jeder `set`-Key muss in `allowed_keys` stehen, sonst Fehler. |
| `section.write` | `briefing-v1` | `max_chars?: number` (Default 16000) | Identisch zu `briefing-v1`: nicht-leerer Text, `≤ max_chars`, `target != null` → genau eine `section.replace`-Action. |

Der Ausdruckskraft-Sprung liegt fast ganz in `frontmatter.set` + `allowed_keys`
(Tagger, Kategorisierer, Status-/Prioritäts-Setzer). `section.write` macht nur
ehrlich, dass `briefing-v1` bereits generisch war.

**`frontmatter.set` ist strikt sicherer als `triage-v1`:** Das heutige `triage-v1`
lässt jeden Key durch, der eine `slugTable` hat oder ein primitiver Wert ist. Das
`allowed_keys`-Gate *verengt* diese Fläche — es lockert nichts.

### Syntax (inline am `llm`-Task)

```yaml
# NEU — parametrisierte Familie:
- id: tag
  kind: llm
  agent: tagger
  inputs: [collect]
  instruction: | …
  output:
    family: frontmatter.set
    allowed_keys: [tags, kategorie]
  on_error: abort

# ALT — bleibt gültig (Alias, s.u.):
- id: triage
  kind: llm
  output_schema: triage-v1
```

Ein `llm`-Task hat **entweder** `output:` **oder** `output_schema:`, nie beides
(Preflight-Fehler). Fehlt beides → Fehler wie heute.

### Rückwärtskompatibilität via Alias-Auflösung

`output_schema:` bleibt gültig und wird beim **Parsen** auf ein `OutputSpec`
aufgelöst — an *einer* Stelle in `crew-parser.ts`:

- `triage-v1` → `{ family: 'frontmatter.set', allowedKeys: '*' }`
- `briefing-v1` → `{ family: 'section.write', maxChars: 16000 }`

Das interne Sentinel **`allowedKeys: '*'`** (Wildcard: alle Keys erlaubt, Enum/
Source-Binding wie gehabt) reproduziert das heutige `triage-v1`-Verhalten
**byte-identisch** — null Verhaltensänderung, Regressionstest trivial grün. Neue
Crews mit expliziter Key-Liste sind strikter. Der Wildcard ist **nur** über den
Alias erreichbar; die neue `output:`-Syntax verlangt eine explizite Liste (leere/
fehlende `allowed_keys` bei `frontmatter.set` = Preflight-Fehler).

### `allowed_keys` vs. bestehendes `ActionsTaskDef.allowedKeys`

Am `actions`-Task existiert bereits `allowedKeys: string[] | null`. Zuständigkeit
nach diesem Design: Das **Schema-`allowed_keys`** ist die Wahrheit (constrain am
Erzeugungspunkt, wo Source-Binding/Enums sitzen). Das actions-Task-`allowedKeys`
bleibt als zusätzliches Gate bestehen (defense-in-depth), wird aber in neuen Crews
nicht mehr gebraucht. Kein Datenmodell-Umbau.

## Betroffene Module

- **`src/core/types.ts`** — neuer Typ
  `OutputSpec = { family: 'frontmatter.set'; allowedKeys: string[] | '*' } | { family: 'section.write'; maxChars: number }`.
  `LlmTaskDef.outputSchema: SchemaId` → `LlmTaskDef.output: OutputSpec`. `SchemaId`
  schrumpft zur reinen Parser-Eingabe (bleibt für die Alias-Namen).
- **`src/core/schemas.ts`** (Herzstück) — die zwei festen Objekte werden zwei
  **Factories** `makeFrontmatterSet(allowedKeys) → SchemaDef` /
  `makeSectionWrite(maxChars) → SchemaDef`; die `validate()`-Rümpfe wandern fast
  unverändert als Closure über die Parameter hinein. Neuer Einstieg
  `buildSchema(spec: OutputSpec): SchemaDef` ersetzt die `BUILTIN_SCHEMAS`-Map.
  `promptContract`/`outputExample` bleiben pro Familie.
- **`src/core/crew-parser.ts`** — `parseTeamDef` liest am `llm`-Task `output:`
  **oder** `output_schema:` und erzeugt in beiden Fällen ein `OutputSpec`. Neue
  Fehlerklassen: unbekannte `family`, `allowed_keys` fehlt/leer bei
  `frontmatter.set`, artfremder Parameter (z.B. `allowed_keys` an `section.write`),
  beide Felder gleichzeitig. Alias-Auflösung an einer Stelle.
- **`src/core/orchestrator.ts`** — `BUILTIN_SCHEMAS[task.outputSchema]` (Z. 245) →
  `buildSchema(task.output)`. Sonst nichts.
- **`src/core/output-validator.ts`** — **unverändert** (nimmt ein `SchemaDef`, weiß
  nicht, woher es kommt). Beleg, dass die Naht richtig sitzt.

## Testing & Migration

- **TDD** (node-env): erst fehlschlagende Tests für
  1. beide Factories — `validate()`-Verhalten inkl. `allowed_keys`-Gate und
     Wildcard-Fall;
  2. Parser — Alias-Auflösung, `output:`-Parsing, neue Fehlerklassen,
     `output`+`output_schema`-Konflikt;
  3. **Sicherheits-Regression** — unerlaubter Key wird abgelehnt; Source-Binding/
     Slug-Enum-Verstoß weiterhin abgelehnt.
- **Rückwärtskompat-Regression:** `task-triage` (→ `triage-v1`-Alias) und
  `daily-briefing` (→ `briefing-v1`-Alias) verhalten sich byte-identisch. Beispiel-
  Crew-Assets bleiben unverändert.
- **`check:pure`** hält `schemas.ts` obsidian-frei (Factories ändern das nicht).
- **Gate** (`npm run gate` = lint + typecheck + test + check:pure) grün vor Commit.

## Offene Punkte

Keine. Collectors/Actions-Öffnung, Schema-Notes und ein Authoring-UI sind bewusst
außerhalb dieses Teilprojekts (siehe Nicht-Ziele / Roadmap).
