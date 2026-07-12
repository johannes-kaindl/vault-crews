# Crew-Vorlagen + Content-Collector

**Datum:** 2026-07-12
**Status:** Design (approved)
**Scope:** Zweites Teilprojekt der Roadmap „Crew-Vorlagen / Authoring". Baut auf
Teilprojekt 1 (parametrisierbare Output-Schema-Familien, gemergt `36c58d9`) auf:
demonstriert das neue `output:`-Vokabular mit zwei neuen Beispiel-Crews, nimmt
die dafür nötige minimale Collector-Erweiterung (`include_content`) mit, und
dokumentiert das Crew-Authoring im README.

## Roadmap-Kontext

Teilprojekt 1 hat das Output-Vokabular geöffnet (`frontmatter.set`/`section.write`
als parametrisierbare Familien). Dieses Teilprojekt (2/3) liefert **reiche
Vorlagen als lebende Doku + Lückentest**; Teilprojekt 3 (Authoring-UX) folgt separat.

**Der Lückentest hat gegriffen:** Beim Entwurf content-basierter Vorlagen zeigte
sich, dass **kein Collector den Notiz-*Inhalt* für einen dynamischen Ordner
liefert** — `vault.list` gibt nur Pfade+Hash (`content: null`), `tasknotes.query`
gibt projiziertes Frontmatter (`content: null`), `vault.read` braucht **statische**
Pfade, und Collector-Tasks haben keine `inputs` (keine `vault.list → vault.read`-
Verkettung). Die spannendsten Vorlagen (Tagger, die den Text lesen) sind damit
heute nicht baubar. Dieses Teilprojekt schließt genau diese Lücke.

## Problem

Nach Teilprojekt 1 kann eine Crew beliebige Frontmatter-Felder setzen
(`frontmatter.set` + `allowed_keys`), aber:
1. Es gibt keine Beispiel-Crew, die das neue Vokabular demonstriert — die zwei
   mitgelieferten Crews nutzen weiter die Aliase (`triage-v1`/`briefing-v1`).
2. Beide mitgelieferten Crews sind **Pallas-spezifisch** (feste Ordner, Pallas-
   Feldnamen). Ein Store-Fremdnutzer kann sie nicht direkt laufen lassen.
3. Content-basierte Crews sind mangels Collector gar nicht baubar (s. Lückentest).
4. Es fehlt jede Doku zum Schreiben/Anpassen eigener Crews.

## Nicht-Ziele (YAGNI)

- **Keine `allowed_values` pro Key.** `frontmatter.set` + `allowed_keys`
  beschränkt *welche Felder* gesetzt werden, nicht die *erlaubten Werte* eines
  Feldes. Die Slug-Enum-Erzwingung greift nur, wenn im Vault bereits Ist-Werte
  existieren (dann baut `tasknotes.query` die SlugTable). Beim ersten Reifegrad-
  Lauf (noch kein Feld gesetzt) kommt die Wertebeschränkung `keim/wachsend/reif`
  **nur aus dem Prompt**. Das ist eine bewusste, dokumentierte Limitation —
  „allowed values pro Key" wäre ein eigenes späteres Vokabular-Feature.
- **Keine `vault.list → vault.read`-Verkettung / Collector-`inputs`.** Größerer
  Eingriff ins Ausführungsmodell; nicht nötig, da `include_content` an
  `tasknotes.query` den konkreten Bedarf deckt.
- **Kein neuer Collector-Typ.** Die Erweiterung ist additiv an `tasknotes.query`,
  nicht ein dritter/vierter Collector.
- **Keine Migration der bestehenden Crews** auf die neue `output:`-Syntax
  (bleiben auf den Aliasen — byte-identisch, Teilprojekt-1-Beweis erhalten).
- **Kein Release** — sammelt sich mit Teilprojekt 1 im nächsten user-facing
  Release (Release-Hygiene). CHANGELOG `[Unreleased]` wird gepflegt.

## Design

### Teil A — Collector-Erweiterung `include_content`

`tasknotes.query` bekommt ein optionales Param `include_content: true` (Default
`false` → unverändert). Bei `true` liefert die Projektionsstufe (`collectors.ts`
Schritt 5) den Notiz-**Text** im `content`-Feld statt `null` — **nur für die nach
`limit`/`sort` tatsächlich gelieferten Notizen** (`limited`), nicht den ganzen
Ordner. Der Rohtext (`e.raw`) liegt dort bereits vor.

**Caps geteilt mit `vault.read`:** Die Cap-Logik (`PER_FILE_CAP` 32 KB/Datei,
`TOTAL_CAP` 256 KB gesamt, `TRUNCATION_MARKER` `\n[gekürzt]`) wird aus `vaultRead`
in eine kleine Helper-Funktion `capContent(full, runningTotal)` extrahiert und von
beiden Collectors genutzt (DRY). `vaultRead`-Verhalten bleibt byte-identisch.

**Kein Parser-Eingriff:** `CollectorTaskDef.params` ist `Record<string, unknown>`
— `include_content` fließt ungeparst durch; nur `collectors.ts` liest es. Kein
`types.ts`/`crew-parser.ts`-Change.

**Sicherheit:** Source-Binding unberührt (Pfade kommen weiter aus dem Collector);
`TOTAL_CAP` deckelt die Datenmenge unabhängig von `limit`.

### Teil B — Zwei neue Beispiel-Crews

**Vorlage A — Notiz-Tagger (generisch, vault-agnostisch).** Findet Notizen ohne
`tags`, liest ihren Text, schlägt 2–4 Tags vor.
```yaml
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notizen        # ← hier deinen Zielordner eintragen
      where_missing: [tags]
      limit: 15
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: notiz-tagger
    inputs: [collect]
    instruction: | …2–4 knappe thematische Tags…
    output: { family: frontmatter.set, allowed_keys: [tags] }
    on_error: abort
  - id: apply
    kind: actions
    inputs: [tag]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [tags]
```
`folder` (Collector) und `write_scope` zeigen **auf denselben** klar markierten
Beispiel-Ordner (`Notizen` / `Notizen/**/*.md`) mit Prosa-Hinweis „beide auf deinen
Zielordner setzen" — bewusst **nicht** `**/*.md` bzw. ganzer Vault, damit (a) ein
frischer Nutzer nicht versehentlich überall schreibt und (b) Collector-Reichweite
und Schreib-Reichweite konsistent sind (sonst würde `apply` viele Vorschläge außer-
halb `write_scope` verwerfen). `agent: notiz-tagger` (neuer Agent, `thinking: off`
wie alle strukturierten-Output-Agenten — Reasoning-Modell-Regression, s. Tests).

**Vorlage B — Reifegrad-Tagger (Pallas-Demo).** Gleiche Pipeline, setzt ein
`reifegrad`-Feld (`keim`/`wachsend`/`reif`) aus dem Notiz-Inhalt.
`output: { family: frontmatter.set, allowed_keys: [reifegrad] }`, eigener Agent
`reifegrad-tagger`. Trägt in der Prosa die `allowed_values`-Limitation (s. Nicht-
Ziele) offen.

Beide Crews müssen die **echten Parser** (`parseTeamDef`/`parseAgentDef`) unter den
Plugin-Default-Maxima mit `ok:true` durchlaufen (wie alle mitgelieferten Crews) —
sonst schlägt Preflight beim ersten Lauf fehl. `max_writes: 10` (= Plugin-Default).

### Teil C — README-Doku „Eigene Crews schreiben"

Neuer README-Abschnitt, beispielgetrieben: die `output:`-Block-Syntax (beide
Familien + `allowed_keys`/`max_chars`), `include_content`, das `write_scope`-
Sicherheitsmodell, und der Hinweis „die mitgelieferten Crews sind editierbare
Beispiele". Kurz gehalten.

## Betroffene Module

- **`src/core/collectors.ts`** — `capContent`-Helper extrahieren; `vaultRead`
  darauf umstellen (byte-identisch); `tasknotesQuery` liest `include_content` und
  füllt `content` über `capContent` für die `limited`-Notizen.
- **`src/obsidian/example-assets.ts`** — 2 neue Agent-Konstanten
  (`NOTIZ_TAGGER_AGENT`, `REIFEGRAD_TAGGER_AGENT`) + 2 neue Team-Konstanten
  (`NOTIZ_TAGGER_TEAM`, `REIFEGRAD_TAGGER_TEAM`).
- **`assets/examples/`** — 4 neue Klartext-Spiegel-Dateien (byte-identisch zu den
  TS-Konstanten): `agents/notiz-tagger.md`, `agents/reifegrad-tagger.md`,
  `teams/notiz-tagger.md`, `teams/reifegrad-tagger.md`.
- **`src/obsidian/install-examples.ts`** — die 4 neuen Assets in die `assets`-Liste.
- **`README.md`** — neuer Abschnitt „Eigene Crews schreiben".
- **`CHANGELOG.md`** — `[Unreleased]`-Eintrag (Collector `include_content`, 2 Crews, Doku).

## Testing

- **`tests/core/collectors.test.ts`** — TDD: `include_content: true` liefert
  `content` für die gelieferten Notizen; Default (weglassen/false) lässt `content`
  `null`; Cap greift (Text > `PER_FILE_CAP` wird gekürzt mit Marker);
  `capContent`-Refactor lässt `vault.read`-Verhalten unverändert (bestehende
  vault.read-Tests bleiben grün).
- **`tests/obsidian/install-examples.test.ts`** — `EXPECTED_PATHS` um die 4 neuen
  Dateien erweitern; byte-Identitäts-`it.each` um die 4 ergänzen; je ein
  „nicht tot"-Parser-Test für die 2 neuen Teams (parsen `ok:true` unter Default-
  Maxima, `output`-Familie korrekt) + 2 neuen Agenten (`thinking: off`);
  `KNOWN_AGENTS` erweitern.
- **`npm run gate`** grün (lint + typecheck + test + check:pure) vor jedem Commit.
  `collectors.ts` bleibt obsidian-frei.

## Offene Punkte

Keine. `allowed_values`, Collector-`inputs` und die Authoring-UX sind bewusst
außerhalb (siehe Nicht-Ziele / Roadmap).
