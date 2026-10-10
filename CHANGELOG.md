# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

### Changed

- **Masking of API keys in run logs now comes from the shared code-kit module `redact` (code-kit 0.18.0).** Visible differences: if one of your keys is the beginning of another, the longer one is now masked completely (before, the rest of it stayed readable in `run.md`); a key is masked in one pass over the text, so a mask can no longer be hit by a later key.
- **A run whose state cannot be masked now ends as failed (`io`) and writes nothing.** Before, such a state (a circular reference, a value without JSON form) would have escaped the run as an unhandled error and left the run lock set; now the lock is released, `run.md` and `state.json` are left as they were, and you get one notice.

## [0.14.0] — 2026-10-09

### Changed

- **API keys now live in Obsidian's secret storage instead of `data.json`.** This needs Obsidian 1.11.4 or newer (`minAppVersion` was 1.8.7). A key you entered before moves there the next time the plugin resolves its endpoints, at the latest when you start the next run; `data.json` then keeps only a reference. Run logs and `state.json` still mask the key, also when it comes from the secret storage.
- **Secrets in your notes are masked before they reach a model.** Private keys (PEM blocks), `Bearer` tokens and common API-key formats (`sk-…`, `ghp_…`, …) in the text a crew sends are replaced by placeholders (`[redacted-token-1]`); the answer gets the original back before the crew writes it. Crews with a JSON schema get the value JSON-escaped, crews with a Markdown schema (Daily-Briefing) as is. Notes reach the model as JSON text, so a restored PEM block keeps its line breaks written as `\n`. E-mail addresses are not masked.
- The settings row "Level picker in chat" in the Request section is gone: it never had an effect here (a setting you had switched on stays visible so you can switch it off). The section now shows save errors in red.
- Kit 0.51.2 / code-kit 0.15.0 (backend detection and the secret storage come from the shared kit modules).

## [0.13.1] — 2026-10-03

### Changed

- The changelog is now written entirely in English.
- Internal design notes moved out of the repository; the user documentation is unchanged.

## [0.13.0] — 2026-09-30

### Added

- The GitHub release now also carries a ready-to-unpack `vault-crews.zip` (the plugin folder with `main.js`, `manifest.json` and `styles.css`) and a `checksums.sha256` file. For a manual install, download the zip and unpack it into `.obsidian/plugins/` instead of creating the folder and saving three files by hand.

### Changed

- **The sampling values of a run now come from the model profile instead of one fixed set.** Until now every model call went out with the agent's `temperature` (default 0.1) and `max_tokens` plus a fixed "don't think" switch. Now the values depend on the model family (Qwen 3.8/3.6, Gemma 4, gpt-oss; from the LLM Endpoint Manager or estimated from the model name) and the backend (LM Studio, Open WebUI, …), using the kit's profile table for crews (mode `structured`). **Visible effects:** (1) Models get their vendor's recommended `top_p`/`top_k`/`min_p` — answers can differ slightly from 0.12.0. (2) An agent without `temperature` gets the profile value (0.1) instead of a parser default; an agent that names one keeps it, and it beats the plugin's own overrides. (3) **`thinking: auto` (the default) now means "off"** — the thinking level of the mode, changeable in the settings — instead of "send nothing and let the server decide". Models that think by default now get asked not to; a model that thinks anyway raises the "kept reasoning" notice and the `always_on_thinker` line in `run.md`, which is now possible for `auto` agents too. Agents that want thinking say `thinking: on`. (4) **`thinking: on` now sends the level `medium`** (it used to send nothing) and raises the token budget to the family's reserve if needed; While thinking, Qwen models get a temperature of at least 0.6 when the agent sets none (the vendor warns against greedy decoding) — a temperature you write into the agent note is kept as is, and the settings section marks it as below the family's floor. (5) gpt-oss cannot be switched off; it gets its lowest level (`minimal`), never `none`, which its server rejects. (6) The context budget of a run is now computed from the `max_tokens` that is actually sent.
- **Settings: new section "Request"** (collapsed, under the endpoints). It shows per model family what is sent and whether it has an effect on your backend, takes your own values, sets the thinking level for `auto` agents, and shows the last request and any deviations (for example: the model thought although thinking is off; an empty answer because thinking used up the token budget; the server rejected a field). A note in the section reminds that values in an agent note win. The row "Level picker in chat" in that section has no effect here — Vault Crews has no chat button; the kit option to hide it follows.
- Kit chat client 0.44.0 (no user-visible change).

## [0.12.0] — 2026-09-26

### Fixed
- **A timeout or stall is now logged as `timeout` or `stalled`.** Until now production turned it into `error_kind: io`: the abort by the plugin's own timer reached the client as an AbortError from the XHR transport before the client could evaluate the cause. Measured in a running Obsidian against a local fake server (the hard timer and the stall both yielded no error kind); the unit tests did not see it because their stand-in resolved on abort.

### Changed
- **The chat client and the streaming transport now come from the kit** (`createChatClient`, obsidian-kit 0.43.0; `XhrSseTransport` and the own SSE branch of `local-llm-client.ts` are gone). **Visible effects:** the error message of an HTTP response carries the server message as before; an HTTP 200 response with an error body is now an error (`endpoint_error`) instead of an empty answer; the stall timer (60 s) starts with the first received chunk instead of the first token — a server that immediately sends an empty head chunk and then takes a long time to process the prompt can therefore count as "stalled" sooner (until the first chunk only the overall deadline applies, as before). The fallback without a stream now runs through `requestUrl` in the kit and applies per endpoint.
- Kit pin `obsidian-kit` 0.41.1 → 0.43.0; the copies of the kit CSS (`ENDPOINT_LIST_CSS`, `STREAM_AREA_CSS`) in `styles.css` are brought up to the 0.43.0 state.

## [0.11.0] — 2026-09-26

### Added

- **Help row at the very top of the settings** (UI-STANDARD §8): a text button "Open documentation" linking to the documentation index and a bug icon linking to the issue tracker on GitHub. Kit module `help-setting.ts` from obsidian-kit 0.43.0 (pinned individually, the other vendored modules stay unchanged).

## [0.10.0] — 2026-09-25

### Added

- **Run transparency: a collector without matches is now a cause of its own.** `run.md` states per collector task "Found: N note(s) in `<source>`" or "⚠ Collector found 0 matching notes in `<source>` — check folder/filter". After a run, the notice says exactly that for 0 matches and 0 writes instead of "0 files written", the result card and the status line of the crew in the panel name the source, and the notice carries the link "Open log" to the `run.md` of that run. A refused or failed crew states the reason in plain words in its status line.
- **Setting "Hide crew folder in the file explorer"** (default: off). Purely cosmetic, the folder stays in the vault; `folder-hide.ts` was taken over from slide-deck.

### Fixed

- **The "Install example crews" button in the settings now installs by itself.** Until now it only showed a hint to use the command from the command palette, although the identically labelled button in the panel really did install. Both buttons now call the same path.
- **`thinking:off` no longer suppresses thinking for gpt-oss/harmony models** (`local-llm-client.ts`). These models reject `reasoning_effort`/`chat_template_kwargs`/`reasoning_budget` with HTTP 400 instead of ignoring them as a no-op — so the request failed as soon as the thinking suppression was active. Guard `isAlwaysOnThinker(params.model)` (already vendored) before `suppressParams`.

### Changed

- **Endpoints from the LLM Endpoint Manager, when installed.** If the plugin `llm-endpoint-manager` is active, the endpoint of a run comes from there (choice, default model, key from the keychain) and the settings show the manager block instead of the endpoint list (choose endpoint, choose model, adopt local endpoints into the manager). Visible effect: if the manager reports no endpoint, the run refuses with "No reachable LLM endpoint" — there is deliberately no silent fallback to the local list. Without the manager nothing changes, the local list including failover stays. New settings field `choice` (empty = automatic).
- **Kit pin `obsidian-kit` 0.35.0 → 0.41.1, `code-kit` 0.6.0 → 0.7.0**, plus newly vendored `endpoint-source` (pure + obsidian) and `sampling-profiles`; `tools/sync-kit.sh` now knows `relayer_pure`. The rest of the stock comes along (endpoint row editor, settings walker, streaming answer area); nothing changes in the chat requests, `sampling-profiles` is vendored but not yet wired up.
- **Behaviour change: no model call on an empty context any more.** An LLM task whose inputs are all collectors without matches is not started (`skipped`, with the reason in `run.md`); the run therefore ends `partial` instead of `ok`. Tasks with at least one non-empty input run as before.
- **Kit pin `obsidian-kit` 0.27.0 → 0.35.0 (+ code-kit 0.6.0).** All vendored pure modules have been pulled from code-kit since obsidian-kit 2ab1bb5; `tools/sync-kit.sh` (new, taken over from `lingotuner`) makes re-vendoring repeatable. `think.ts` is now called `think-splitter.ts` (module name = file name, as in all other kit consumers).
- **Streaming answer area switched to `buildStreamArea` from the kit** (UI-STANDARD §8, the mandatory building block; previously a custom build). Four behaviour changes (CORE-META-21):
  1. The thinking block stays open during the stream if the user has opened it — before, every full re-render implicitly closed it again until `thinkOpen` reopened it.
  2. The scroll follows the running text only if you are (close to) the bottom anyway (`atBottom` threshold 40px instead of 24px before) — it no longer jumps up when you have scrolled back to read along.
  3. The thinking block is now created **lazily** at the first thinking token (no empty `<details>` as ballast while a task is not thinking) — before, the (empty) summary line was always there.
  4. The token counter in the summary line ("Thinking … N tokens") now only updates on a full render (task boundaries), no longer on every single thinking token — the kit encapsulates the summary line and offers no hook for a live update from outside; the thinking text itself still streams live.

## [0.9.5] — 2026-09-02

### Changed

- **The panel no longer stays silent in three situations where it has something to say.** All three cost time for the person who is just writing their first own crew. (1) A crew file that lies flat in the crew folder instead of in `teams/` or `agents/` is not loaded — the panel reported "No crews yet" for it, the same as for an empty vault. Now it states how many files with `crew-kind:` lie in the wrong place. (2) Whoever created, renamed or changed a crew only saw it after closing and reopening the panel; the list now catches up by itself. (3) A crew whose definition does not parse completely stayed in the list without a hint — the error only showed after starting, in the preflight. The row stays startable (the preflight still names the full error) but now carries a warning triangle whose tooltip names the first message.

### Fixed

- **An API key containing quotation marks, a backslash or a line break ended up unmasked in the vault.** Runs are written to the vault as `run.md`/`state.json`, and a vault gets synced — the masking is meant to prevent exactly that. It ran over the serialization and searched for the key in its **raw** form; in JSON text, however, a `"` appears as `\"` and a line break as `\n`, so the search found nothing, replaced nothing, and the key was written. No error, no hint. The search now also looks for the JSON-escaped form — in addition, not instead: umlauts, CJK and emoji are precisely not escaped by JSON, there the raw form alone carries. Anyone who used an affected key should treat it as compromised and check the existing run logs.

## [0.9.4] — 2026-09-02

### Fixed

- **An endpoint that reports its error in FastAPI format now shows the server message instead of raw JSON.** When a backend answers with `{"detail":"Not authenticated"}` — the shape sent by OpenWebUI and other Python gateways — exactly this JSON body appeared in the error message, because the field `detail` was never read. Now it says "Not authenticated". The plugin already knew three field shapes (`error.message`, `error`, `message`); `detail` is the fourth.
- **An empty error field no longer swallows the message.** If a server answered with `{"error":"","message":"model not found"}`, you saw "HTTP 400: " or "Non-streaming response without content: " — without any error text, although the server had sent one: the empty string counted as a hit and at the same time was not empty enough for the raw-text fallback to kick in. Empty fields and fields consisting only of whitespace now fall through, the search continues over the remaining fields, and if none of them matches, the raw text of the response appears.

## [0.9.3] — 2026-08-18

### Fixed

- **An answer truncated at the token limit is now called that — and no longer costs a second attempt.** If an agent runs into its `max_tokens` budget, the answer breaks off mid-sentence; the result is incomplete JSON. Until now this was reported as "The model's output could not be parsed even after a repair attempt" — that is, as a quality problem of the model, while the cause is a number in the agent note. In addition, a repair round ran against exactly the same limit and was therefore certain to be wasted. Now the run ends as `output_truncated` with the hint to raise `max_tokens`, and without the second call (measured on a live run: before `invalid_output` after 2 calls and 9 s, now `output_truncated` after 1 call and 2 s). A truncated answer that is valid anyway remains a successful run.

## [0.9.2] — 2026-08-17

### Changed

- **The settings can be found again.** From Obsidian 1.13 the host queries the settings declaratively (`getSettingDefinitions()`); whoever does not offer that, their fields simply do not appear in the settings search — none of them. The plugin now offers them and keeps drawing the same structure itself via the kit walker as long as Obsidian is older than 1.13. Otherwise nothing changes visibly: the same four groups, the same rows, the same endpoint editor.

## [0.9.1] — 2026-08-17

### Fixed

- **An endpoint with a missing or wrong API key now says so.** Instead of an explanation, the raw translation key `settings.endpoint.status.unauthorized` stood in this place — it looked like a text but was not one. It hit precisely the case for which the status class was introduced with 0.9.0: a hosted gateway that answers with 401 or 403. Now it says "Access denied — API key missing or invalid." (DE: "Zugriff verweigert — Schlüssel fehlt oder ist ungültig."). A completeness guard in the typecheck makes sure that a future status class from the kit does not slip through untranslated again.

## [0.9.0] — 2026-08-17

### Added

- **API key per endpoint.** Each row of the endpoint list now carries its own key — so a fallback list can mix local and hosted providers: first LM Studio, and when that is off, an OpenAI-compatible gateway. The key also goes to the reachability probe; a gateway that answers unauthenticated with 401 would otherwise wrongly count as dead.
- **The model belongs to the endpoint row.** It is chosen per row from a dropdown of the models *this* endpoint reports (with "Reload model list" per row). An agent may still name its own `model:`; it applies as long as the active endpoint carries it, otherwise the task runs on the model of the row — otherwise the fallback would break exactly when it is needed.
- **Capabilities of the active model** are shown below the list (reasoning, images) — and honestly labelled: "guessed from the name" appears where it was guessed.
- **Reorder rows** ("use first"), a role display per row ("active" / "standby — place 2" / "unreachable") and a hint as soon as a row carries a key: requests then leave the computer.

### Changed

- **The undo dialog now has a "Cancel" button.** Until now there was only "Undo" — whoever wanted to get rid of the dialog had to press Esc or click away. Both buttons now sit in Obsidian's native button row (Cancel on the left).
- The list of blocked endpoints is a plain text field (one address per line) instead of a row editor — a block is not a connection and needs neither status nor model.
- **The global field "Default model" is gone.** A model name exists only on the endpoint that reports it; a global field next to it was the same information in two places. Existing settings are adopted automatically on first start: the old endpoint list becomes entries, the former default model moves into the rows.

### Security

- **API keys are removed from everything written to the vault** — run log (`run.md`), `state.json` and error messages in the panel. Error bodies are the likely way there: some gateways mirror the sent Authorization header in their answer, and a vault gets synchronised.

## [0.8.0] — 2026-08-14

### Added

- **Live token streaming in the run panel**: while a task runs, the sidebar now shows the model's real token text (content scrollable, reasoning in the collapsible "Thinking" area) instead of just a counter. Reasoning tokens are captured for real for the first time (`thinkCount`) — from `<think>` blocks and the `reasoning_content` field. The live text updates incrementally and scrolls along as long as you are at the bottom.

### Fixed

- **The "Thinking" area stays open if you have opened it**: until now it collapsed again at the first content token — that is, exactly when the answer begins and you are reading along with the train of thought. The area still starts collapsed; only your own expansion now survives a redraw of the panel.

## [0.7.0] — 2026-07-12

### Fixed

- **Classify HTTP errors honestly**: an error status from the LLM server (server reachable, request/model rejected) is now reported as the new error class `endpoint_error` instead of wrongly as `endpoint_unreachable` ("no connection"). Affects the next-action message in the panel.
- **Readable error body**: error messages no longer show just `HTTP 400: {` — the plain-text message is pulled from the JSON error body (`error.message`/`error`/`message`) and shown on one line.
- **Detect always-on thinkers at runtime**: models that keep thinking despite `thinking: off` are now recognised by their actual reasoning (not only by the model name `gpt-oss`/`harmony`) — the hint notice therefore also applies to models like ornith, and its text is model-agnostic.

## [0.6.0] — 2026-07-12

### Added

- **`output:` block for `llm` tasks**: parameterisable output families (`frontmatter.set`, `section.write`) with `allowed_keys`/`max_chars` — the crew output vocabulary is thereby open. The previous `output_schema: triage-v1|briefing-v1` remain valid as an alias, byte-identical.
- `frontmatter.set` supports **list values** (e.g. `tags: [work, note]`); the slug enum check applies per list element.
- `tasknotes.query` supports `include_content: true` (delivers note content for the delivered notes).
- Two new example crews: **Note Tagger** (generic, vault-agnostic) and **Maturity Tagger** (Pallas demo) — demonstrate the `output:` vocabulary (`frontmatter.set`) with content.
- README section "Writing your own crews" (output: syntax, include_content, write_scope).

## [0.5.0] — 2026-07-11

### Added

- `create_if_missing` flag for `section.replace` tasks in crews: creates the target file
  (marker block, no template) including missing parent folders instead of failing in a
  controlled way. The Daily Briefing example crew uses it and no longer needs today's daily
  note beforehand. Undo removes the created note (trash).

## [0.4.0] — 2026-07-10

### Added

- Endpoint management UI in the settings: row editor for endpoints (add/remove,
  per-row connection status with error classes, active marker, non-blocking input
  warnings, one-click presets for LM Studio and Ollama) and for blocked endpoints.
- Default model as a dropdown, loaded from the active endpoint (`Load models`), with
  free-text fallback offline; a saved model choice that is currently not listed stays
  available as an option.

### Changed

- The connection test now runs per endpoint row (live status) instead of via a global button.
- `endpoint_diagnostics` (status classification, presets, input check) vendored from
  `obsidian-kit`; `endpoint.ts` raised to the kit state (`parseEndpointList`).

## [0.3.0] — 2026-07-08

### Added

- Ollama support without a provider setting: context-length probe (`/api/show`),
  cross-provider thinking suppression, CORS non-stream fallback,
  always-on-thinker detection (gpt-oss/harmony) with a run.md note + notice.

### Changed

- `LmStudioClient` → `LocalLlmClient` (provider-agnostic name).

## [0.2.0] — 2026-07-07

### Changed

- **Git-free snapshot undo.** "Undo last run" no longer relies on the vault being a git
  repository. Before a run writes a note, the plugin snapshots that note's pre-run state
  (copy-on-write, write-ahead) into a hidden store under
  `.obsidian/plugins/vault-crews/undo/<runId>/`, via the Obsidian vault/adapter API only.
  Undo restores changed notes from the snapshot and moves run-created notes to the
  Obsidian trash (never a hard delete). This works in **every** vault, not just git repos.
- **Honest conflict warning.** If a note was edited after the run but before undo (detected
  via content hash), the confirmation dialog warns before rolling it back — never a silent
  overwrite.
- **New setting "Undo history depth"** (default 15) controls how many recent runs keep an
  undo snapshot; older snapshots are pruned automatically.

### Removed

- **All `child_process` and `node:fs` usage.** The git-backed undo (system `git commit` /
  `git revert`) is gone, so the plugin no longer performs shell execution or direct
  filesystem access — removing both Community-store review "Behavior" warnings. Vaults that
  want a permanent versioned history can still run git themselves; the run logs
  (`run.md`) remain the durable human-readable record.

## [0.1.0] — 2026-07-06

### Added

- **Deterministic crew pipeline.** A crew ("team") runs as a fixed sequence of three
  task kinds — `collector` (deterministic context gathering), `llm` (one schema-bound
  chat completion), `actions` (deterministic application of a validated action list).
  The model decides *content* only, inside narrow contracts; the orchestrator decides
  flow, paths and writes.
- **Constrain-then-verify before every write.** Every LLM output is extracted,
  validated against a built-in versioned schema, and source-bound (no invented paths or
  enum values), with a one-shot repair pass for malformed JSON.
- **One git commit per run with one-click undo.** Every run — ok, partial, failed or
  aborted — ends in exactly one commit covering only the files it touched plus its run
  log. Undo survives a dirty working tree (stash-wrapped `git revert`).
- **Run panel with hub navigation.** A single view with internal tabs (Crews · History),
  a persistent status line carrying the one cancel button, and honest cooperative-abort
  feedback (a run that finished before the abort landed says so rather than freezing).
- **Two shipped example crews**, installable via a command: Task-Triage and
  Daily-Briefing.
- **Full in-vault observability.** Each run writes a human-readable `run.md` (Bases-
  compatible) and a machine-readable state file.
- **Local-model-aware LM Studio client** — context length probing, thinking suppression,
  JIT stall timeout, ordered endpoint fallback.
