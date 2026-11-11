---
crew-kind: team
name: Task-Triage
version: 1
description: Prüft Backlog-TaskNotes auf fehlende oder inkonsistente Metadaten und schlägt Korrekturen an weichen Feldern vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Aufgaben/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Aufgaben
      where: { status: [backlog] }
      limit: 25
      fields: [title, status, priority, kontext, projekt, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]
    instruction: |
      Bewerte jede Aufgabe: fehlende priority? leerer kontext? fehlendes projekt oder period, obwohl thematisch naheliegend? Schlage pro Aufgabe höchstens eine Frontmatter-Korrektur vor. Bei Unsicherheit: nichts vorschlagen.
    output_schema: triage-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, kontext, projekt, period]
---
## Task-Triage

Prüft den Backlog im Ordner `Aufgaben/` und schlägt Korrekturen an **weichen** Feldern vor (priority, kontext, projekt, period) – niemals an status oder type (strukturell erzwungen über `allowed_keys` im `apply`-Task).

**Vor dem ersten Lauf anpassen:** Trage bei `params.folder` UND bei `write_scope` den Ordner mit deinen Aufgaben-Notizen ein (beide zeigen bewusst auf denselben Ordner), und passe Feld-Liste, Statuswert (`backlog`) und Instruktion an dein Schema an. Nach der Installation ist alles frei editierbar.

**Schreiblimit:** `limits.max_writes` steht auf 10, weil das Plugin-Standardlimit (Einstellungen → Sicherheit → „Max. Schreibvorgänge pro Lauf“) ebenfalls bei 10 liegt und jeden Wert nach oben deckelt. Ein frisch installiertes Team soll nicht schon an der eigenen Preflight-Validierung scheitern. Wer mehr braucht, hebt zuerst das Plugin-Limit an und danach dieses Feld.
