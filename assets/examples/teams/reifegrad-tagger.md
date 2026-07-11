---
crew-kind: team
name: Reifegrad-Tagger
version: 1
description: Schätzt den Reifegrad von Notizen aus ihrem Inhalt und schreibt ihn ins Frontmatter.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "20_Zettel/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 20_Zettel
      where_missing: [reifegrad]
      limit: 15
      fields: [reifegrad]
      include_content: true
  - id: classify
    kind: llm
    agent: reifegrad-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keinen Reifegrad haben. Ordne
      jeder GENAU einen Reifegrad zu: keim, wachsend oder reif. Nutze nur diese
      drei Werte. Bei zu wenig Inhalt: nichts zuordnen.
    output:
      family: frontmatter.set
      allowed_keys: [reifegrad]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [classify]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [reifegrad]
---
## Reifegrad-Tagger

Pallas-Demo: schätzt für die Zettel in `20_Zettel/` einen Reifegrad
(`keim`/`wachsend`/`reif`) aus dem Inhalt und schreibt ihn ins Frontmatter
(`frontmatter.set` mit `allowed_keys: [reifegrad]`, `include_content: true`).

**Bewusste Limitation — Wertebeschränkung nur aus dem Prompt:** `frontmatter.set`
+ `allowed_keys` beschränkt, WELCHE Felder gesetzt werden, aber nicht die
erlaubten WERTE eines Feldes. Die strukturelle Enum-Erzwingung (Slug-Wertemenge)
greift erst, wenn `reifegrad` im Ordner bereits Ist-Werte hat. Beim allerersten
Lauf kommt die Beschränkung auf `keim/wachsend/reif` daher nur aus der Instruktion
und dem Agent-Prompt. „Erlaubte Werte pro Feld" ist bewusst noch kein Feature.
