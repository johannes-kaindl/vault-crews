# Vault Crews

Run autonomous local LLM agent teams ("crews") on your Obsidian vault, powered by a
local [LM Studio](https://lmstudio.ai/) model — with a deterministic, orchestrator-led
pipeline and a git safety net under every run.

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
- **One git commit per run, one-click undo.** Every run — successful, partial, or
  failed — ends in exactly one commit covering only the files it touched, plus its
  own run log. Undo is `git revert <commit>`, wired to a single button.
- **Two shipped example crews**, installable via a command: **Task-Triage** (reviews
  backlog TaskNotes, proposes metadata corrections on soft fields only) and
  **Daily-Briefing** (summarizes open tasks into today's daily note).
- **Full observability, in the vault.** Every run writes a human-readable `run.md`
  (frontmatter + per-task detail, Bases-compatible) and a machine-readable
  `state.json`, plus a shipped `runs.base` dashboard.
- **Crash recovery.** An orphaned lock + a `state.json` still marked `running` are
  detected on the next plugin load, with one recommended action: commit the partial
  state.
- English/German UI.

## Requirements

- **Desktop only** (`isDesktopOnly: true` — the plugin shells out to `git` via
  `child_process` and talks to a local HTTP server; neither is available on mobile).
- **[LM Studio](https://lmstudio.ai/)** running locally, serving its OpenAI-compatible
  API at `http://localhost:1234` by default (configurable, with a fallback list).
- **Enable CORS in LM Studio** (LM Studio → Settings → Developer → *Enable CORS*).
  The plugin streams model output via `XMLHttpRequest` from inside Obsidian's
  renderer process (`requestUrl` cannot stream); without CORS enabled, LM Studio
  rejects those requests and every run refuses at preflight with an
  endpoint-unreachable error.
- **A git repository at the vault root — mandatory, no opt-out.** This is not a
  setting you can turn off: PREFLIGHT refuses to run at all if the vault root isn't a
  git repository. The commit-per-run **is** the undo net; there is no code path that
  writes to the vault without it.

## Install (BRAT)

Vault Crews is not (yet) in the community plugin directory. Install it via
[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update
Tool):

1. Install the **BRAT** community plugin from Obsidian's community plugin browser.
2. In BRAT's settings, "Add beta plugin" and point it at this repository
   (`https://codeberg.org/jkaindl/vault-crews`).
3. Enable **Vault Crews** under Community plugins.
4. Run the command **"Install example crews"** to seed `_crews/` (default root,
   configurable in settings) with the Task-Triage and Daily-Briefing example teams,
   their agents, and the `runs.base` dashboard. Installed files are never
   overwritten by a second run — edit them freely afterwards.

## Safety model

- **`write_scope` whitelist, per team, plus a fixed denylist that always wins.** Every
  team declares the vault-relative globs it may write to. A fixed denylist —
  `.obsidian/**`, `.git/**`, `_crews/**`, `_vaultrag/**`, dotfiles — overrides any
  whitelist unconditionally; crews can never read or write their own configuration
  (no self-triggering, no prompt-injection path into plugin control).
- **One git commit per run, always — one-click undo.** Even a failed or aborted run
  with partial writes commits (labelled as partial); uncommitted agent writes are
  never left lying around. **Undo last run** reverts the run's commit with one click
  and shows exactly what it will undo (team, time, commit, files) before you confirm.
- **Write and wall-clock limits.** `max_writes` per run (team-configurable, capped by
  a plugin-wide maximum), a hard per-note size cap, an LLM call budget, and a
  wall-clock watchdog (default 10 minutes) that aborts a runaway run with a partial
  commit rather than running forever.
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

- The plugin talks to exactly one network endpoint: your local LM Studio instance
  (default `http://localhost:1234`, user-configurable with a fallback list). No other
  host is ever contacted, no telemetry, no analytics, no update-check pings.
- Port 8080 is denylisted by default (commonly reserved by other local
  single-consumer model servers) — this is a default *setting*, not a hardcoded
  behavior, and can be changed.
- `git` operations run against your local vault repository via `child_process`; no
  network git operations (fetch/push) are ever performed by the plugin.

## V1 limitations

Documented rather than silently missing:

- **No mid-run transport retry / endpoint re-resolve.** If LM Studio dies or the
  connection drops mid-stream, the current call fails and the run ends `failed` with
  a partial commit; the plugin does not attempt to reconnect or re-resolve the
  endpoint within a run. This is deliberately deferred to V2 — a failed run is always
  safe (git commit + full log) and cheap to re-run: `section.replace` is idempotent
  and `note.create`/patch semantics refuse to double-apply, so simply re-running the
  same crew after restarting LM Studio is the supported recovery path.
- **Crash recovery assumes a single device.** The orphaned-run detection (stale lock
  + `state.json` still `running`) is designed for "Obsidian crashed on this machine
  mid-run". A vault synced across two concurrently-running Obsidian desktops (e.g.
  via iCloud/Syncthing while both are open) is explicitly out of scope for V1 — see
  design risk #8.
- **`verboseLogging` (Settings → Advanced) is reserved, not yet wired.** The setting
  exists and persists, but nothing currently reads it; full raw-output mitschnitt
  beyond the existing failure-case `artifacts/` capture is not implemented.
- **The failure log opens `run.md` at the top, not scrolled to the failed task.**
  "View failure" opens the run's log file via `workspace.getLeaf().openFile()` with
  no ephemeral scroll state — you land at the top of the note and scroll to the
  relevant `##` section yourself.
- **Ports are built once, at plugin load.** The LM Studio endpoint and the call/stall
  timeout settings are read once in `onload()` to construct the `LlmClient`; changing
  the endpoint or timeout values in Settings does not affect an already-running
  plugin instance. Disable and re-enable the plugin (or restart Obsidian) after
  changing these settings for them to take effect.

## License

AGPL-3.0-or-later. See `package.json` for the full license identifier.
