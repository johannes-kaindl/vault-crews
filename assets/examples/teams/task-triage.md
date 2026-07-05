---
crew-kind: team
name: Task-Triage
version: 1
description: Prüft Backlog-TaskNotes auf fehlende oder inkonsistente Metadaten und schlägt Korrekturen an weichen Feldern vor.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "10_Aufgaben/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: 10_Aufgaben
      where: { status: [backlog] }
      limit: 25
      fields: [title, status, priority, kontext, projekt, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]
    instruction: |
      Bewerte jede Aufgabe: fehlende priority? leerer kontext? fehlendes
      projekt oder period, obwohl thematisch naheliegend? Schlage pro Aufgabe
      höchstens eine Frontmatter-Korrektur vor. Bei Unsicherheit: nichts
      vorschlagen.
    output_schema: triage-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, kontext, projekt, period]
---
## Task-Triage

Prüft den Backlog in `10_Aufgaben/` und schlägt Korrekturen an **weichen**
Feldern vor (priority, kontext, projekt, period) – niemals an status oder
type (strukturell erzwungen über `allowed_keys` im `apply`-Task, Spec §4.3).

Nach der Installation frei editierbar: Ordner, Feld-Liste, Instruktion,
`limits.max_writes` (das Plugin-Standardlimit aus den Einstellungen deckelt
jeden Wert nach oben, siehe Abweichung unten).

**Abweichung von Spec §2.3:** `limits.max_writes` steht hier auf 10 statt der
im Spec-Beispiel genannten 15, weil das Plugin-Standardlimit (Einstellungen →
Sicherheit → „Max. Schreibvorgänge pro Lauf“) ebenfalls bei 10 liegt. Ein
frisch installiertes Team soll nicht schon bei der eigenen Preflight-
Validierung an diesem Limit scheitern. Wer mehr als 10 Schreibvorgänge pro
Lauf braucht, hebt zuerst das Plugin-Limit an und danach dieses Feld.
