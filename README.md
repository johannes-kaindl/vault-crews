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
   (`https://codeberg.org/jkaindl/vault-crews`).
3. Enable **Vault Crews** under Community plugins.

**After enabling**, run the command **"Install example crews"** to seed `_crews/`
(default root, configurable in settings) with the Task-Triage and Daily-Briefing
example teams, their agents, and the `runs.base` dashboard. Installed files are never
overwritten by a second run — edit them freely afterwards.

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

## License

AGPL-3.0-or-later — see [`LICENSE`](LICENSE) for the full text.
