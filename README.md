# Vault Crews

Run autonomous local LLM agent teams ("crews") on your Obsidian vault, powered by a
local LLM model ([LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.ai/)) — with a
deterministic, orchestrator-led pipeline and a snapshot safety net under every run.

Local models are treated as weak, unreliable executors. The orchestrator decides
*flow, paths and writes*; the model only ever decides *content*, inside narrow,
schema-validated contracts. Every output is constrained, then verified, before it
ever touches your vault.

## Features

- **Deterministic pipeline, not a free-form agent loop.** A crew ("team") is a
  sequence of exactly three task kinds — `collector` (deterministic context
  gathering), `llm` (one chat completion against a schema-validated contract), and
  `actions` (deterministic application of a validated action list to the vault). The
  model never controls flow and never touches the vault directly.
- **Constrain-then-verify before every write.** Every LLM output is extracted,
  schema-validated against a built-in, versioned schema, and source-bound — a model
  cannot invent a file path or an enum value that didn't already exist in the
  collected material. A repair pass (one retry) handles malformed JSON.
- **Git-free snapshot undo, one click.** Before a run touches a note, its pre-run state
  is snapshotted (copy-on-write) into a hidden store via the Obsidian vault/adapter API.
  "Undo last run" restores changed notes from the snapshot and moves run-created notes to
  the trash — no git repository required, works in any vault.
- **Two shipped example crews**, installable via a command: **Task-Triage** (reviews
  backlog TaskNotes, proposes metadata corrections on soft fields only) and
  **Daily-Briefing** (summarizes open tasks into today's daily note).
- **Full observability, in the vault.** Every run writes a human-readable `run.md`
  (frontmatter + per-task detail, Bases-compatible) and a machine-readable
  `state.json`, plus a shipped `runs.base` dashboard.
- **Crash recovery.** An orphaned lock + a `state.json` still marked `running` are
  detected on the next plugin load, with one recommended action: finish the run
  (keep the partial changes — they remain undoable via the write-ahead snapshot).
- English/German UI.

## Requirements

- **Desktop only** (`isDesktopOnly: true` — the plugin is built around a locally-hosted
  LLM served over HTTP, a desktop workflow).
- **A local LLM server:** [LM Studio](https://lmstudio.ai/) (default port `1234`) or
  [Ollama](https://ollama.ai/) (default port `11434`), serving an OpenAI-compatible API.
  The endpoint is configurable in the plugin settings; just enter the URL (e.g.,
  `http://localhost:1234/v1` for LM Studio or `http://localhost:11434/v1` for Ollama).
  You can list several endpoints (one per line), and the plugin uses the first
  reachable one at each preflight. No provider selection needed — the plugin
  auto-detects context length and capabilities.
- **Enable CORS** on your LLM server. The plugin streams model output via `XMLHttpRequest`
  from inside Obsidian's renderer process (`requestUrl` cannot stream). **LM Studio:**
  Settings → Developer → *Enable CORS*. **Ollama:** set the environment variable
  `OLLAMA_ORIGINS=<your-obsidian-app-url>` (optional; without it, the plugin falls back
  to non-streaming mode, and results still arrive).
- **No git repository required.** The undo net is a per-run snapshot taken via the
  Obsidian vault/adapter API, so it works in any vault — git repo or not. (Earlier
  versions required a git repo; as of 0.2.0 that requirement is gone.)

## Install

**From Community plugins (once listed):** open **Settings → Community plugins →
Browse**, search for **Vault Crews**, install and enable it.

**Before it is listed — via BRAT** ([Beta Reviewers Auto-update
Tool](https://github.com/TfTHacker/obsidian42-brat)):

1. Install the **BRAT** community plugin from Obsidian's community plugin browser.
2. In BRAT's settings, "Add beta plugin" and point it at this repository
   (`https://git.jkaindl.de/jkaindl/vault-crews`).
3. Enable **Vault Crews** under Community plugins.

**After enabling**, run the command **"Install example crews"** to seed `_crews/`
(default root, configurable in settings) with the Task-Triage and Daily-Briefing
example teams, their agents, and the `runs.base` dashboard. Installed files are never
overwritten by a second run — edit them freely afterwards.

## Usage

1. **Start your local LLM server** (LM Studio or Ollama) with CORS enabled, and load a
   model. The plugin resolves the first reachable endpoint at each preflight.
2. **Run "Install example crews"** once — it seeds the crew root (`_crews` by default)
   with the Task-Triage and Daily-Briefing teams, their agents, and the `runs.base`
   dashboard.
3. **Open the crews panel** (ribbon icon or **Open crews panel**). It lists the teams it
   found and, during a run, the current task with live token counts.
4. **Start a run** with **Run crew…** and pick a team, or use the per-team command
   **Run crew: &lt;name&gt;** that every team registers under its own name.
5. **Watch it work.** The panel shows each task's status (waiting, running, ok, failed,
   skipped, stale). **Abort current run** requests a stop, observed between tasks and
   inside the model stream.
6. **Read the log.** Every run writes `run.md` (human-readable, Bases-compatible) and
   `state.json` next to it; **Open last run log** jumps there, and `runs.base` lists all
   runs at once.
7. **Undo if needed.** **Undo last run** shows what it would restore (team, time, files)
   and asks before doing it — changed notes are restored from the snapshot, run-created
   notes go to the trash.

Writing your own teams and agents is plain Markdown in the vault — see
[Eigene Crews schreiben](#eigene-crews-schreiben) below.

## Configuration

**Settings → Community plugins → Vault Crews**, in four groups:

| Setting | Default | Meaning |
|---|---|---|
| **Endpoints** | `http://localhost:1234/v1` | One per line; the first reachable one is used per run. **Check connections** probes each line and reports refused / unknown host / timeout / not-an-LLM-API separately |
| **Denied endpoints** | `localhost:8080`, `127.0.0.1:8080` | Never contacted — the default keeps the plugin off a port other local model servers commonly claim. A setting, not hardcoded |
| **Default model** | *(empty)* | Model name sent with each call; **Load models** fills a dropdown from the reachable endpoint |
| **Crew root folder** | `_crews` | Vault-relative folder holding agents, teams and run logs |
| **Max writes per run** | 10 | Plugin-wide cap; a team's own `max_writes` can only be lower |
| **Wall-clock limit** | 10 minutes | Aborts a runaway run, leaving its partial writes snapshotted and undoable |
| **Undo history depth** | 15 | How many run snapshots are kept before the oldest are pruned |
| **Call timeout** | 300 s | Hard limit per model call — generous, because just-in-time model loading takes a while |
| **Stall timeout** | 60 s | Aborts if no new token arrives; only checked after the first token, so loading is never mistaken for a stall |
| **Verbose logging** | off | Reserved — the setting persists but nothing reads it yet (see V1 limitations) |

Endpoint and timeout settings are read once at plugin load; changing them takes effect
after disabling and re-enabling the plugin.

## How it works

A run is an **orchestrator walking a fixed pipeline**, not a model deciding what to do
next. Each team is a sequence of exactly three kinds of task:

1. **`collector`** — deterministic gathering. Code, not the model, reads the vault and
   assembles the material (e.g. `tasknotes.query` over a folder, optionally with note
   content).
2. **`llm`** — exactly one chat completion, answering against a schema declared by the
   task's `output:` block. The model sees only the collected material and produces only
   content — never a path, never a flow decision.
3. **`actions`** — deterministic application. The validated action list is applied to
   the vault by code.

Between the model and your notes sit **two independent checks**. Stage 1
(`output-validator`) parses the raw response, validates it against a built-in versioned
schema, and binds every path and enum value back to the material actually collected —
a path the model invented has nothing to bind to and is rejected. One repair attempt
handles malformed JSON. Stage 2 (`action-executor`) re-checks each action immediately
before the write, independently of stage 1: against the `write_scope` allowlist and the
fixed denylist, the allowed action types and frontmatter keys, and a content hash — if
you edited the file after it was collected, that action is skipped rather than
overwriting your edit. If more than half of a task's actions fall away, the task fails
instead of applying a half-consistent state.

Writes are snapshotted **write-ahead**: a note's pre-run content is copied into a hidden
per-run store through the Obsidian vault/adapter API before it is touched. That is why
even a crashed or aborted run stays fully undoable, and why no git repository is needed.

## Safety model

- **`write_scope` whitelist, per team, plus a fixed denylist that always wins.** Every
  team declares the vault-relative globs it may write to. A fixed denylist —
  `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, dotfiles — overrides any
  whitelist unconditionally; crews can never read or write their own configuration
  (no self-triggering, no prompt-injection path into plugin control).
- **A snapshot under every write — one-click undo.** Before each note is written, its
  pre-run content is captured write-ahead into a hidden per-run store (under
  `.obsidian/plugins/vault-crews/undo/`). Even a failed or aborted run with partial
  writes stays fully undoable. **Undo last run** restores changed notes and trashes
  run-created ones, showing exactly what it will undo (team, time, files) before you
  confirm — and warns if a note was edited after the run rather than silently
  overwriting it. Run-created notes go to the Obsidian trash, never a hard delete.
- **Write and wall-clock limits.** `max_writes` per run (team-configurable, capped by
  a plugin-wide maximum), a hard per-note size cap, an LLM call budget, and a
  wall-clock watchdog (default 10 minutes) that aborts a runaway run (leaving its
  partial writes snapshotted and undoable) rather than running forever.
- **Consistency threshold.** If more than 50% of a task's proposed actions are
  rejected or stale, the whole task fails instead of applying a semantically
  inconsistent partial state; below that threshold, individual actions are skipped
  and logged.
- **Constrain-then-verify, twice.** Stage 1 (`output-validator`) validates the raw
  model JSON against a built-in schema and binds every path/enum value to the
  material actually collected for that task. Stage 2 (`action-executor`) re-checks
  every action against the path whitelist/denylist, allowed action types, allowed
  frontmatter keys, and a content-hash staleness guard (if you edited the file since
  it was collected, that single action is skipped, never silently overwritten) —
  immediately before the write, independent of stage 1.

## Network disclosure

- The plugin talks to exactly one network endpoint: your local LLM server
  (LM Studio `http://localhost:1234/v1` or Ollama `http://localhost:11434/v1` by default,
  user-configurable). No other host is ever contacted, no telemetry, no analytics, no
  update-check pings.
- Port 8080 is denylisted by default (commonly reserved by other local
  single-consumer model servers) — this is a default *setting*, not a hardcoded
  behavior, and can be changed.
- No shell execution and no direct filesystem access: the undo net writes its
  snapshots through the Obsidian vault/adapter API only, never `child_process` or
  `node:fs`.

## V1 limitations

Documented rather than silently missing:

- **No mid-run transport retry / endpoint re-resolve.** If LM Studio dies or the
  connection drops mid-stream, the current call fails and the run ends `failed` with
  its partial writes snapshotted; the plugin does not attempt to reconnect or re-resolve the
  endpoint within a run. This is deliberately deferred — a failed run is always
  safe (undo snapshot + full log) and cheap to re-run: `section.replace` is idempotent
  and `note.create`/patch semantics refuse to double-apply, so simply re-running the
  same crew after restarting LM Studio is the supported recovery path.
- **Crash recovery assumes a single device.** The orphaned-run detection (stale lock
  + `state.json` still `running`) is designed for "Obsidian crashed on this machine
  mid-run". A vault synced across two concurrently-running Obsidian desktops (e.g.
  via iCloud/Syncthing while both are open) is explicitly out of scope for V1 — see
  design risk #8.
- **Raw LLM output on validation failure is captured under `runs/<id>/artifacts/`.**
  Whenever a task's output fails schema/source-binding validation, the raw model
  response is written to `artifacts/<taskId>-1.txt`; if the one repair attempt also
  fails validation, its raw response is written to `artifacts/<taskId>-2.txt`. This
  feeds the test-fixture corpus of real broken model outputs and is written under the
  run directory — it is never counted as a vault write, never touches `max_writes`, and
  is not snapshotted for undo. Successful runs write no artifacts at all.
- **`verboseLogging` (Settings → Advanced) is reserved, not yet wired.** The setting
  exists and persists, but nothing currently reads it; full raw-output recording of
  *every* call (success or failure) — beyond the failure-case `artifacts/` capture
  above — is not implemented.
- **The failure log opens `run.md` at the top, not scrolled to the failed task.**
  "View failure" opens the run's log file via `workspace.getLeaf().openFile()` with
  no ephemeral scroll state — you land at the top of the note and scroll to the
  relevant `##` section yourself.
- **Ports are built once, at plugin load.** The LM Studio endpoint and the call/stall
  timeout settings are read once in `onload()` to construct the `LlmClient`; changing
  the endpoint or timeout values in Settings does not affect an already-running
  plugin instance. Disable and re-enable the plugin (or restart Obsidian) after
  changing these settings for them to take effect.
- **Aborting a run is cooperative — and the panel is honest about it.** "Cancel" /
  "Abort current run" sets the abort flag, which is observed between tasks and inside
  the LLM stream; when it bites you get `status: aborted` with partial writes (undoable). With a
  fast local model a whole run can finish in 1–2 s, so a click can land after the last
  checkpoint and the run completes normally — that is *correct* (the work was already
  done), not a lost click. The panel reflects this truthfully: while aborting it shows
  "Abort requested…", and if the run finished first it states "the run finished before
  the abort took effect — nothing was aborted" rather than freezing on a spinner. There
  is deliberately no mechanism to throw away already-completed work.

## Eigene Crews schreiben

Eine Crew ist Markdown im Vault: ein **Team** (`crew-kind: team`) als Pipeline aus
`collector → llm → actions`, plus **Agent**-Notes (`crew-kind: agent`, System-Prompt
im Body). Die mitgelieferten Crews (Command „Install example crews") sind editierbare
Beispiele — kopiere und passe sie an.

### Output-Vokabular (`output:`)

Ein `llm`-Task legt sein Ausgabeformat über einen `output:`-Block fest:

- **`frontmatter.set`** — das Modell schlägt Frontmatter-Werte für Quell-Notizen vor.
  `allowed_keys` beschränkt, welche Felder gesetzt werden dürfen. Pfade sind an das
  Quellmaterial gebunden (keine Halluzination); die strukturelle Enum-Erzwingung
  bindet Werte an die im Vault vorhandenen Ist-Werte, greift aber erst, wenn das Feld
  im Ordner bereits belegte Werte hat — beim allerersten Lauf (noch keine Werte, keine
  Wertetabelle) kommt eine Wertebeschränkung nur aus Instruktion und Agent-Prompt.
  ```yaml
  output:
    family: frontmatter.set
    allowed_keys: [tags, kategorie]
  ```
- **`section.write`** — das Modell schreibt Markdown-Text, der per `section.replace`
  in das `target` des nachgelagerten `actions`-Tasks geschrieben wird. Optional
  `max_chars` (Default 16000).
  ```yaml
  output:
    family: section.write
  ```

Die älteren Namen `output_schema: triage-v1` / `briefing-v1` bleiben als Kurzform gültig.

### Inhalt lesen (`include_content`)

Standardmäßig liefert `tasknotes.query` nur Frontmatter. Für Crews, die den
Notiz-**Text** brauchen (Tagger, Zusammenfasser), setze `include_content: true`:

```yaml
collector: tasknotes.query
params:
  folder: Notizen
  where_missing: [tags]
  include_content: true
```

### Schreib-Sicherheit (`write_scope`)

`write_scope` ist eine Glob-Allowlist: eine Crew darf nur dort schreiben. Setze sie
so eng wie möglich — und lass `collector`-`folder` und `write_scope` auf denselben
Ordner zeigen, sonst werden Vorschläge außerhalb der Schreibfreigabe verworfen. Das
Plugin-Limit „Max. Schreibvorgänge pro Lauf" deckelt zusätzlich jeden `max_writes`-Wert.

## License

AGPL-3.0-or-later — see [`LICENSE`](LICENSE) for the full text.
