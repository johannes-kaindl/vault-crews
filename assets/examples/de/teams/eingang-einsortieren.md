---
crew-kind: team
name: Eingangsordner einsortieren
version: 1
description: Versieht die Notizen eines Eingangsordners mit vorhandenen Tags und legt jede in einen passenden Ordner ab.
trigger: manual
review: false
limits:
  max_writes: 8
write_scope:
  - "Inbox/**/*.md"
  - "Projekte/**/*.md"
  - "Archiv/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Inbox
      limit: 8
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: eingang-sortierer
    inputs: [collect]
    instruction: |
      Du bekommst Notizen aus dem Eingangsordner samt Inhalt. Wähle pro Notiz bis zu drei Tags, die zum Inhalt passen, AUSSCHLIESSLICH aus der Liste der vorhandenen Tags. Passt kein Tag, wähle keinen.
    output:
      family: frontmatter.set
      allowed_keys: [tags]
      values:
        tags: { from: tags }
      add_to: [tags]
    on_error: abort
  - id: file
    kind: llm
    agent: eingang-sortierer
    inputs: [collect]
    instruction: |
      Du bekommst Notizen aus dem Eingangsordner samt Inhalt. Nenne pro Notiz den Ordner, in den sie gehört, AUSSCHLIESSLICH aus der Liste der Ordner. Passt kein Ordner eindeutig, antworte none.
    output:
      family: note.file
      destinations:
        - { folder: Projekte, when: "Notizen, die zu einem laufenden Projekt gehören" }
        - { folder: Archiv, when: "Abgeschlossene Notizen und Notizen, die nicht mehr gebraucht werden" }
    on_error: abort
  - id: apply-tags
    kind: actions
    inputs: [tag]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [tags]
  - id: apply-move
    kind: actions
    inputs: [file]
    allowed_actions: [note.move]
---
## Eingangsordner einsortieren

Sieht sich die Notizen im Ordner `Inbox/` an (höchstens 8 je Lauf), ergänzt passende Tags aus den Tags, die in deinem Vault schon vorkommen (`add_to: [tags]` lässt die eigenen Tags einer Notiz stehen), und verschiebt jede Notiz in einen der Ordner unter `destinations`. Eine Notiz ohne eindeutigen Ordner bleibt, wo sie ist.

**Vor dem ersten Lauf anpassen:** Drei Ordner müssen zu deinem Vault passen. Der Eingangsordner (`Inbox`) bei `params.folder` UND bei `write_scope`; die Zielordner (`Projekte`, `Archiv`) bei `destinations` UND bei `write_scope`. Die Zielordner müssen schon existieren, die Crew legt nie einen Ordner an. Ersetze die Beschreibungen bei `when` durch je einen kurzen Satz für deine Ordner; das Modell wählt nach diesen Sätzen. Mit `destinations_from: Projekte` werden zusätzlich alle Unterordner von `Projekte` angeboten (bis zu 100). `write_scope` steht absichtlich NICHT auf dem ganzen Vault.

**Verschieben ändert Links anderswo:** Verschiebt Obsidian eine Notiz, passt es auch die Links auf sie in anderen Notizen an, so wie du es in den Obsidian-Einstellungen gewählt hast. Dabei können Notizen außerhalb von `write_scope` geändert werden; die Grenze gilt für die verschobene Notiz, nicht für die Verweise auf sie. Rückgängig schiebt die Notiz zurück und passt die Links wieder an.

**Schreiblimit:** `max_writes: 8` zählt Notizen, nicht Aktionen: eine Notiz, die Tags bekommt und verschoben wird, zählt einmal. 8 Notizen je Lauf bleiben unter dem Plugin-Standard von 10; für größere Stapel zuerst das Plugin-Limit anheben (Einstellungen → Sicherheit → „Max. Schreibvorgänge pro Lauf“), dann `limit` und `max_writes` hier.

**Noch keine Vorschau:** `review: false` heißt, die Crew schreibt sofort; die Vorschau kommt mit einem späteren Release. Prüfe das Ergebnis im Lauf-Protokoll und nutze bei Bedarf Rückgängig.
