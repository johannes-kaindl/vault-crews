---
crew-kind: team
name: Sort inbox
version: 1
description: Tags the notes in an inbox folder with existing tags and files each one into a matching folder.
trigger: manual
review: false
limits:
  max_writes: 8
write_scope:
  - "Inbox/**/*.md"
  - "Projects/**/*.md"
  - "Archive/**/*.md"
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
    agent: inbox-sorter
    inputs: [collect]
    instruction: |
      You receive notes from the inbox with their content. For each note pick up to three tags that fit its content, ONLY from the list of existing tags. If no tag fits, pick none.
    output:
      family: frontmatter.set
      allowed_keys: [tags]
      values:
        tags: { from: tags }
      add_to: [tags]
    on_error: abort
  - id: file
    kind: llm
    agent: inbox-sorter
    inputs: [collect]
    instruction: |
      You receive notes from the inbox with their content. For each note give the folder it belongs in, ONLY from the list of folders. If no folder fits clearly, answer none.
    output:
      family: note.file
      destinations:
        - { folder: Projects, when: "Notes that belong to a current project" }
        - { folder: Archive, when: "Finished notes and notes that are no longer needed" }
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
## Sort inbox

Looks at the notes in the `Inbox/` folder (at most 8 per run), adds fitting tags from the tags that already exist in your vault (`add_to: [tags]` keeps a note's own tags) and moves each note into one of the folders listed under `destinations`. A note without a clear folder stays where it is.

**Adjust before the first run:** Three folders have to match your vault. The inbox folder (`Inbox`) at `params.folder` AND at `write_scope`; the target folders (`Projects`, `Archive`) at `destinations` AND at `write_scope`. Target folders must already exist, the crew never creates a folder. Replace the descriptions at `when` with a short sentence for each of your folders; the model chooses by these sentences. `destinations_from: Projects` additionally offers every subfolder of `Projects` (up to 100). `write_scope` is deliberately NOT the whole vault.

**Moving changes links elsewhere:** When Obsidian moves a note it also updates the links to it in other notes, as set in your Obsidian settings. **The crew only starts if “Automatically update internal links” is switched on there** (Settings → Files & Links; it is off by default in Obsidian, so switch it on for this crew); otherwise Obsidian asks in a dialog in the middle of the run. That can change notes outside `write_scope`; the limit applies to the moved note, not to the links pointing to it. Undo moves the note back and updates the links again.

**Write limit:** `max_writes: 8` counts notes, not actions: a note that is tagged and moved counts once. 8 notes per run stay below the plugin default of 10; for larger batches raise the plugin limit (Settings → Safety → "Max writes per run") first, then `limit` and `max_writes` here.

**No preview yet:** `review: false` means the crew writes right away; the preview comes with a later release. Check the result in the run log and use Undo if needed.
