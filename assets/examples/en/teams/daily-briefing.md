---
crew-kind: team
name: Daily briefing
version: 1
description: Summarises open tasks into a short daily briefing and writes it into today's daily note.
trigger: manual
limits:
  max_writes: 1
write_scope:
  - "Daily/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Tasks
      where: { status: [backlog, active] }
      sort: priority
      limit: 30
      fields: [title, status, priority, context, project, due]
  - id: briefing
    kind: llm
    agent: briefing-author
    inputs: [collect]
    instruction: |
      You receive open tasks (backlog + active, none completed) with title, status, priority, context, project and, if present, a due date (due). Write a short daily briefing in Markdown with EXACTLY these three sections:

      ## Due today
      ## Overdue
      ## One next action

      Sort each task into a section as best you can: a due date in the past belongs under "Overdue"; a task without a due date but with status "active" belongs under "Due today". If a section is empty, write one short, reassuring sentence instead of an empty list. "One next action" names exactly ONE concrete task from the list that can be started right away.
    output_schema: briefing-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [briefing]
    allowed_actions: [section.replace]
    target: "Daily/{{today}}.md"
    create_if_missing: true
---
## Daily briefing

Summarises the open tasks in `Tasks/` into a short briefing and writes it with `section.replace` into today's daily note (`Daily/{{today}}.md`, file name in the format `YYYY-MM-DD`). The block sits between the markers `<!-- crew:daily-briefing -->` … `<!-- /crew:daily-briefing -->`. Thanks to `create_if_missing: true`, today's daily note is created if it does not exist yet (only the marker block, no template). Undo removes a note created this way again (trash).

**Adjust before the first run:** Enter the folder with your task notes at `params.folder`, and the folder and date format of your daily notes at `write_scope` and `target` (the core plugin "Daily notes" shows both in its settings).

**Deliberate simplification – one model call:** This example crew uses ONE llm task (agent `briefing-author`) instead of separate analyst and author roles. For a single short briefing per day the intermediate step adds little but costs another model call (and with it time and room for errors).

**Deliberate simplification – no hard date limits:** The `tasknotes.query` collector has no date-range filter – `where` only compares values from a list, not `>` or `<` on dates. At run time only the `target` field of an `actions` task expands `{{today}}`; the `instruction` of an `llm` task is static text, so the current date cannot reliably be passed to the model. Rather than pretend to a capability that does not exist, `collect` fetches all open tasks (backlog + active) including the optional `due` field, and `briefing-author` sorts them into the three sections as best it can. If you need hard date limits, extend the team after installation with your own logic (for example an `actions` pre-task that filters by date).

**Write limit:** `max_writes: 1` (exactly the one daily note) – deliberately tighter than the plugin's default limit of 10, because this team structurally never writes more than one file.
