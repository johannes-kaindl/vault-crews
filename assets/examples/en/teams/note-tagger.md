---
crew-kind: team
name: Note tagger
version: 1
description: Reads notes without tags and suggests 2–4 thematic tags based on their content.
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
      where_missing: [tags]
      limit: 15
      fields: [tags]
      include_content: true
  - id: tag
    kind: llm
    agent: note-tagger
    inputs: [collect]
    instruction: |
      You receive notes with their content that have no tags yet. Suggest 2–4 concise, thematic tags **as a list** per note, derived solely from the content. Invent no topics; for notes with little content, fewer or none.
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
## Note tagger

A generic, vault-agnostic example crew: finds notes **without** `tags` in the `Notes/` folder, reads their content (`include_content: true`) and suggests 2–4 thematic tags (`frontmatter.set` with `allowed_keys: [tags]`).

**Adjust before the first run:** Enter your target folder at `params.folder` AND at `write_scope` (both deliberately point to the same folder, so that no notes are collected that lie outside the write permission). `write_scope` is deliberately NOT the whole vault (`**/*.md`), so that a freshly installed team does not write everywhere by accident.
