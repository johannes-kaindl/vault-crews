---
crew-kind: team
name: Maturity tagger
version: 1
description: Estimates the maturity of notes from their content and writes it into the frontmatter.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Notes/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Notes
      where_missing: [maturity]
      limit: 15
      fields: [maturity]
      include_content: true
  - id: classify
    kind: llm
    agent: maturity-tagger
    inputs: [collect]
    instruction: |
      You receive notes with their content that have no maturity level yet. Assign each EXACTLY one maturity level: seed, growing or mature. Use only these three values. If there is too little content: assign nothing.
    output:
      family: frontmatter.set
      allowed_keys: [maturity]
    on_error: abort
  - id: apply
    kind: actions
    inputs: [classify]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [maturity]
---
## Maturity tagger

Estimates a maturity level (`seed`/`growing`/`mature`) from the content of the notes in the `Notes/` folder and writes it into the frontmatter (`frontmatter.set` with `allowed_keys: [maturity]`, `include_content: true`).

**Adjust before the first run:** Enter your target folder at `params.folder` AND at `write_scope` (both deliberately point to the same folder). The field name and values (`maturity`, `seed`/`growing`/`mature`) are a suggestion; adapt them to your own schema.

**Deliberate limitation – value restriction only from the prompt:** `frontmatter.set` + `allowed_keys` restricts WHICH fields are set, but not the allowed VALUES of a field. Structural enum enforcement (slug value set) only applies once `maturity` already has real values in the folder. On the very first run the restriction to `seed`/`growing`/`mature` therefore comes only from the instruction and the agent prompt. "Allowed values per field" is deliberately not a feature yet.
