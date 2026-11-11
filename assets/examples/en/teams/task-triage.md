---
crew-kind: team
name: Task triage
version: 1
description: Checks backlog task notes for missing or inconsistent metadata and suggests corrections to soft fields.
trigger: manual
limits:
  max_writes: 10
write_scope:
  - "Tasks/**/*.md"
tasks:
  - id: collect
    kind: collector
    collector: tasknotes.query
    params:
      folder: Tasks
      where: { status: [backlog] }
      limit: 25
      fields: [title, status, priority, context, project, period]
  - id: analyse
    kind: llm
    agent: triage-analyst
    inputs: [collect]
    instruction: |
      Review each task: missing priority? empty context? missing project or period although one clearly fits? Suggest at most one frontmatter correction per task. When unsure: suggest nothing.
    output_schema: triage-v1
    on_error: abort
  - id: apply
    kind: actions
    inputs: [analyse]
    allowed_actions: [frontmatter.patch]
    allowed_keys: [priority, context, project, period]
---
## Task triage

Checks the backlog in the `Tasks/` folder and suggests corrections to **soft** fields (priority, context, project, period) – never to status or type (enforced structurally through `allowed_keys` in the `apply` task).

**Adjust before the first run:** Enter the folder that holds your task notes at both `params.folder` AND `write_scope` (both deliberately point to the same folder), and adapt the field list, the status value (`backlog`) and the instruction to your own schema. Everything is freely editable after installation.

**Write limit:** `limits.max_writes` is 10 because the plugin's default limit (Settings → Safety → "Max writes per run") is also 10 and caps every value from above. A freshly installed team should not fail its own preflight validation on that limit. If you need more, raise the plugin limit first and then this field.
