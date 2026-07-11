---
crew-kind: team
name: Notiz-Tagger
version: 1
description: Liest Notizen ohne Tags und schlägt 2–4 thematische Tags aus dem Inhalt vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Notizen/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notizen
      where_missing: [tags]
      limit: 15
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: notiz-tagger
    inputs: [collect]
    instruction: |
      Du bekommst Notizen samt Inhalt, die noch keine Tags haben. Schlage pro
      Notiz 2–4 knappe, thematische Tags vor, abgeleitet ausschließlich aus dem
      Inhalt. Erfinde keine Themen; bei inhaltsarmen Notizen weniger oder keine.
    output:
      family: frontmatter.set
      allowed_keys: [tags]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [tag]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [tags]
---
## Notiz-Tagger

Generische, vault-agnostische Beispiel-Crew: findet Notizen **ohne** `tags` im
Ordner `Notizen/`, liest ihren Inhalt (`include_content: true`) und schlägt
2–4 thematische Tags vor (`frontmatter.set` mit `allowed_keys: [tags]`).

**Vor dem ersten Lauf anpassen:** Trage bei `params.folder` UND bei
`write_scope` deinen Zielordner ein (beide zeigen bewusst auf denselben Ordner,
damit nicht Notizen gesammelt werden, die außerhalb der Schreibfreigabe liegen).
`write_scope` steht absichtlich NICHT auf dem ganzen Vault (`**/*.md`), damit ein
frisch installiertes Team nicht versehentlich überall schreibt.
