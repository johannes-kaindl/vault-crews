/** Example crews, English version: contents as TS string constants because esbuild does not
 *  bundle .md/.base files — this is the run-time source that install-examples.ts writes into
 *  the vault when the Obsidian UI language is not German. The German version lives in
 *  `example-assets.ts`. `assets/examples/en/**` is the plain-text mirror of these contents
 *  (byte-identical, checked by tests/obsidian/install-examples.test.ts) — keep BOTH places in
 *  sync. Default folders are neutral (`Tasks`, `Daily`, `Notes`); every team says in its text
 *  that you adjust them. Paragraphs sit on one line (Obsidian would otherwise break mid-paragraph). */

export const TRIAGE_ANALYST_AGENT = `---
crew-kind: agent
name: Triage analyst
temperature: 0.1
max_tokens: 2048
thinking: off
---
You are a sober task triage analyst for a personal Obsidian vault. You review task notes by their frontmatter and ONLY suggest metadata corrections to soft fields (priority, context, project, period). You invent nothing, you delete nothing, you never change title, status or type. When unsure, you suggest NOTHING.
`;

export const BRIEFING_AUTHOR_AGENT = `---
crew-kind: agent
name: Briefing author
temperature: 0.2
max_tokens: 1536
thinking: off
---
You write a short, calm daily briefing for a personal Obsidian vault. You receive a list of open tasks (title, status, priority, context, project and, if present, due date) as JSON. From it you write concise Markdown with EXACTLY three sections: "Due today", "Overdue", "One next action". You use only titles from the source material and never invent tasks. If a section is empty, you write one short, reassuring sentence instead of an empty list. "One next action" names exactly ONE concrete task that can be started right away – your choice, not a list.
`;

export const TASK_TRIAGE_TEAM = `---
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

Checks the backlog in the \`Tasks/\` folder and suggests corrections to **soft** fields (priority, context, project, period) – never to status or type (enforced structurally through \`allowed_keys\` in the \`apply\` task).

**Adjust before the first run:** Enter the folder that holds your task notes at both \`params.folder\` AND \`write_scope\` (both deliberately point to the same folder), and adapt the field list, the status value (\`backlog\`) and the instruction to your own schema. Everything is freely editable after installation.

**Write limit:** \`limits.max_writes\` is 10 because the plugin's default limit (Settings → Safety → "Max writes per run") is also 10 and caps every value from above. A freshly installed team should not fail its own preflight validation on that limit. If you need more, raise the plugin limit first and then this field.
`;

export const DAILY_BRIEFING_TEAM = `---
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

Summarises the open tasks in \`Tasks/\` into a short briefing and writes it with \`section.replace\` into today's daily note (\`Daily/{{today}}.md\`, file name in the format \`YYYY-MM-DD\`). The block sits between the markers \`<!-- crew:daily-briefing -->\` … \`<!-- /crew:daily-briefing -->\`. Thanks to \`create_if_missing: true\`, today's daily note is created if it does not exist yet (only the marker block, no template). Undo removes a note created this way again (trash).

**Adjust before the first run:** Enter the folder with your task notes at \`params.folder\`, and the folder and date format of your daily notes at \`write_scope\` and \`target\` (the core plugin "Daily notes" shows both in its settings).

**Deliberate simplification – one model call:** This example crew uses ONE llm task (agent \`briefing-author\`) instead of separate analyst and author roles. For a single short briefing per day the intermediate step adds little but costs another model call (and with it time and room for errors).

**Deliberate simplification – no hard date limits:** The \`tasknotes.query\` collector has no date-range filter – \`where\` only compares values from a list, not \`>\` or \`<\` on dates. At run time only the \`target\` field of an \`actions\` task expands \`{{today}}\`; the \`instruction\` of an \`llm\` task is static text, so the current date cannot reliably be passed to the model. Rather than pretend to a capability that does not exist, \`collect\` fetches all open tasks (backlog + active) including the optional \`due\` field, and \`briefing-author\` sorts them into the three sections as best it can. If you need hard date limits, extend the team after installation with your own logic (for example an \`actions\` pre-task that filters by date).

**Write limit:** \`max_writes: 1\` (exactly the one daily note) – deliberately tighter than the plugin's default limit of 10, because this team structurally never writes more than one file.
`;

export const NOTE_TAGGER_AGENT = `---
crew-kind: agent
name: Note tagger
temperature: 0.2
max_tokens: 1024
thinking: off
---
You are a sober tagger for a personal Obsidian vault. You receive the content of individual notes and suggest 2–4 concise, thematic tags per note: lowercase, without #, each a single word or a short hyphenated term, delivered as a list. You rely only on the note's content and invent no topics. For a note with little content you suggest fewer tags or none.
`;

export const MATURITY_TAGGER_AGENT = `---
crew-kind: agent
name: Maturity tagger
temperature: 0.1
max_tokens: 1024
thinking: off
---
You are a sober maturity assessor for the notes of a personal Obsidian vault. You receive the content of individual notes and assign each EXACTLY one maturity level: "seed" (a loose thought, keywords), "growing" (in progress, partly worked out) or "mature" (fully worked out, self-contained). You use only these three values and rely only on the content you are given. If there is too little content to judge, you assign nothing.
`;

export const NOTE_TAGGER_TEAM = `---
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

A generic, vault-agnostic example crew: finds notes **without** \`tags\` in the \`Notes/\` folder, reads their content (\`include_content: true\`) and suggests 2–4 thematic tags (\`frontmatter.set\` with \`allowed_keys: [tags]\`).

**Adjust before the first run:** Enter your target folder at \`params.folder\` AND at \`write_scope\` (both deliberately point to the same folder, so that no notes are collected that lie outside the write permission). \`write_scope\` is deliberately NOT the whole vault (\`**/*.md\`), so that a freshly installed team does not write everywhere by accident.
`;

export const MATURITY_TAGGER_TEAM = `---
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

Estimates a maturity level (\`seed\`/\`growing\`/\`mature\`) from the content of the notes in the \`Notes/\` folder and writes it into the frontmatter (\`frontmatter.set\` with \`allowed_keys: [maturity]\`, \`include_content: true\`).

**Adjust before the first run:** Enter your target folder at \`params.folder\` AND at \`write_scope\` (both deliberately point to the same folder). The field name and values (\`maturity\`, \`seed\`/\`growing\`/\`mature\`) are a suggestion; adapt them to your own schema.

**Deliberate limitation – value restriction only from the prompt:** \`frontmatter.set\` + \`allowed_keys\` restricts WHICH fields are set, but not the allowed VALUES of a field. Structural enum enforcement (slug value set) only applies once \`maturity\` already has real values in the folder. On the very first run the restriction to \`seed\`/\`growing\`/\`mature\` therefore comes only from the instruction and the agent prompt. "Allowed values per field" is deliberately not a feature yet.
`;

export const RUNS_BASE = `filters:
  and:
    - note["crew-kind"] == "run"
formulas:
  fehlerklasse: if(error_kind != null, error_kind, "—")
properties:
  team:
    displayName: Team
  status:
    displayName: Status
  writes:
    displayName: Writes
  llm_calls:
    displayName: Model calls
  duration_s:
    displayName: Duration (s)
  model:
    displayName: Model
  formula.fehlerklasse:
    displayName: Error class
  error_task:
    displayName: Error task
  commit:
    displayName: Commit
  started:
    displayName: Started
views:
  - type: table
    name: 🤖 All runs
    order:
      - file.name
      - team
      - status
      - writes
      - llm_calls
      - duration_s
      - model
      - formula.fehlerklasse
      - commit
      - started
    sort:
      - property: started
        direction: DESC
  - type: table
    name: ⚠️ Needs attention
    filters:
      and:
        - or:
            - status == "failed"
            - status == "refused"
            - status == "aborted"
    order:
      - file.name
      - team
      - status
      - formula.fehlerklasse
      - error_task
      - started
    sort:
      - property: started
        direction: DESC
  - type: table
    name: ✅ Successful
    filters:
      and:
        - or:
            - status == "ok"
            - status == "partial"
    order:
      - file.name
      - team
      - status
      - writes
      - duration_s
      - started
    sort:
      - property: started
        direction: DESC
`;
