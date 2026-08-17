---
crew-kind: team
name: Reading digest
version: 1
description: Reads this week's notes and writes a short digest into the overview note.
trigger: manual
limits:
  max_writes: 1
write_scope:
  - "Notes/Weekly overview.md"
tasks:
  - id: collect
    kind: collector
    collector: vault.read
    params:
      paths:
        - "Notes/Migration plan.md"
        - "Notes/Vendor call.md"
        - "Notes/Storage costs.md"
        - "Notes/Retry behaviour.md"
  - id: summarise
    kind: llm
    agent: digest-writer
    inputs: [collect]
    instruction: |
      Write a three-sentence digest of the notes below. Name the recurring
      topic first, then what changed, then what is still open. Plain prose,
      no bullet points, no headings.
    output:
      family: section.write
      max_chars: 700
    on_error: abort
  - id: write
    kind: actions
    inputs: [summarise]
    allowed_actions: [section.replace]
    target: "Notes/Weekly overview.md"
---
## Reading digest

Collects four notes from `Notes/`, asks the model for a short digest and writes it
into the marked section of the overview note — nothing else. The write scope allows
exactly one file, and `max_writes: 1` caps the run at a single change.

Every run is snapshotted before the first write, so **Undo** in the panel puts the
note back byte for byte.
