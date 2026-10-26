# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

### Added

- The **Models** line of a crew in the run panel now also names the model each agent used in its last run (**Last run: Analyst (analyse): …**), next to the wish and the fallback it already shows. The line comes from the run itself and is kept per crew, so it survives a restart; before a crew has run, or for a crew saved by an earlier version, it is absent.

### Fixed

- A `note.create` action into a folder that does not exist yet creates the folder, the way `section.replace` already did, instead of ending the run with an `io` error. No built-in schema produces this action yet, so no run is affected today.

## [0.22.0] — 2026-10-25

### Added

- The panel shows which model and thinking level each agent of a crew gets (read-only): a **Models** line under each crew in the **Crews** tab, one entry per LLM task. A `model:` in the agent note is shown as a wish that counts if the active endpoint carries that model, next to the model of the endpoint row as the fallback; the panel does not ask the endpoint, so it does not claim which of the two applies. **Change the fallback model in the settings** opens the plugin's settings. The model that a finished run actually used is not shown yet.

### Changed

- A `write_scope` entry is now stored in a normalised form when the crew file is read, the way the path of an action already was: a `write_scope` of `./a/**` or `a/./b/**`, which was refused as a "protected area", is valid now and means `a/**` and `a/b/**`; `\` separates like `/` (`a\b/**` is `a/b/**`), doubled slashes drop out, and the entry stays in that form in the team. Before, `a\b/**` and `a//b/**` were accepted as typed and never matched a write.
- A `write_scope` entry with a leading `/` or `\` (an absolute path such as `/abs/**`) is refused when the crew file is read, with its own message: `write_scope` is relative to the vault, and reading `/abs/**` as `abs/**` would grant write access somewhere the author did not mean. Before, it was accepted as typed and never matched a write.
- A `write_scope` entry that ends in a slash or a `.` segment (`a/`, `a/**/`, `a/.`) is refused when the crew file is read, with its own message. Such an entry matched nothing before (paths do not end in `/`), and normalising it would have made it take effect; a normalisation never gives an entry more write access than its wording had.
- A `write_scope` entry with a NUL byte is refused when the crew file is read, with its own message.
- A `write_scope` entry that would be the vault root (`.`, `./`, `/`) is refused as an "ungültiger Eintrag". `/` was accepted before and stored as typed, but never took effect, so it is now a definition error.
- The protection of the deny-list is unchanged; what changed is which spellings a `write_scope` accepts.

## [0.21.3] — 2026-10-24

### Security

- A `write_scope` with a `..` segment (`../x/**`, `a/../b/**`, `a/ .. /b/**`, `**/../x`, `a\..\b/**`) is now refused when the crew file is read, with its own message (`".." is not allowed in write_scope`). Before, the deny-list caught most spellings by accident and reported them as "protected area", and `a/ .. /b/**` (blanks around the dots) was accepted. No write could have escaped (every write is checked against the path itself), but a boundary entry that can never take effect belongs in the error list, not in the crew.

### Changed

- Kit update (obsidian-kit 0.63.0 → 0.69.1, code-kit 0.34.0 → 0.36.0). Nothing changes for a crew run: the endpoint list knows a new row role "used for search — does not write", which this plugin never sets (its row text is now covered by a test), and the shared path module treats an unreadable path as inside a guarded folder, which the deny-list and the collector here do not use.

## [0.21.2] — 2026-10-23

### Security

- The write boundary of a crew now reads a path the way the file system does. The deny-list (`_crews/**`, `_vaultrag/**`, `.git/**` and the configuration folder) used to compare the path as typed, so a crew with a broad `write_scope` could write into the protected folders under a spelling that lands on the same folder on disk: `_crews /x.md` or `_crews./x.md` (Windows drops blanks and dots at the end of a name), `_crews:s/x.md` (everything after a colon is a data stream of the name before it) and `_CREWS/x.md` (macOS and Windows fold the case, also `ſ` for `s` and the Kelvin sign for `k`). Such paths are now refused, and a `write_scope` whose root lies in a protected folder in one of these spellings is rejected when the crew is read. Other paths are not affected; the whitelist itself keeps comparing the text, so `Projekte /x.md` is still not inside `Projekte/**`.

### Changed

- Kit update (code-kit 0.31.0 → 0.34.0) for the path check above. Claude models (`claude-sonnet-5-5`, `anthropic/claude-…`) are recognised as models that take images and, from the Fable, Opus 4.7 and Sonnet 5 generations on, as thinking that cannot be switched off, so the "Request" section shows the matching hint; local models that only carry the word "claude" in their name (`qwen3.6-claude-opus-distill`) are unchanged.

## [0.21.1] — 2026-10-18

### Changed

- Internal: removed the `.nvmrc` file left over from the project template (no other plugin of this author carries one). The Community Store's source review could not install dependencies for 0.21.0; this release is a fresh attempt. Nothing changes in the plugin.

## [0.21.0] — 2026-10-18

### Changed

- Kit update (obsidian-kit 0.61.0 → 0.63.0, code-kit 0.28.0 → 0.31.0). The thinking block of the run panel has a copy button, and long lines in the live answer wrap instead of running off the right edge.
- Paths in a crew are checked by the shared kit module `rel-path`: a `.` segment no longer survives (`./a.md` is read as `a.md`, so the deny-list and `write_scope` see both spellings the same), and a path with a NUL byte or a `..` padded with blanks (`".. "`) is now refused like any other `..`.
- Listing the notes of a folder (the collectors and the crew-folder watcher) uses the shared kit module `folder-scope`: whole folder names only, names that differ only in Unicode normal form (`Ü` as one or two code points) match, and a folder containing `..` holds nothing. An empty `folder` in a collector still means the whole vault; an empty crew folder in the settings still watches nothing.
- LM Studio: whether a model thinks or sees images now comes from its metadata instead of only its name, so thinking is recognised for more models.
- The "Request" section shows a button "Set family in the manager" next to the hint "Model family detected", warns when a request would load another model in LM Studio and push a loaded one out (JIT displacement), names the Claude field "Thinking effort (effort)", and has its own wording for a field the backend refuses to take.

### Added

- Crews can run on a schedule: `trigger: interval` with `interval: 30m` (units `m`, `h`, `d`, at least `5m`) starts a team by itself while Obsidian is open. The first run comes one interval after the plugin loads, a tick that meets an active run is skipped, and nothing is caught up after Obsidian was closed. Schema validation, `write_scope`, write cap and undo apply as for a manual run.

## [0.20.1] — 2026-10-16

### Documentation

- The README hero shows the new status icons and the thinking counter.

## [0.20.0] — 2026-10-16

### Fixed

- **The "Thinking… N tokens" counter in the panel counts tokens, not chunks.** A model that delivers its whole thinking in one piece (Gemma 4 after the reset) showed "1 tokens" above a long thought; the number is now estimated from the text length, the same way the run log estimates it.
- **Gemma 4 on LM Studio: the model's thinking no longer shows up as the answer in the panel.** It writes its thinking into the answer text without an opening marker and closes it with `<channel|>`; the panel now moves that text into the collapsible thinking block and shows only the answer. A model family or alias the plugin cannot tell from its name is handled through the family the plugin already knows. A thinking-despite-off warning no longer appears for Gemma 4 on LM Studio, where thinking cannot be switched off.

### Changed

- **Kit pins raised to `obsidian-kit` 0.61.0 and `code-kit` 0.28.0** (from 0.60.1 and 0.27.1). Visible effects of the skipped releases (obsidian-kit 0.60.2, 0.60.3, 0.61.0; code-kit 0.27.2, 0.28.0): with a Gemma 4 model on LM Studio, "thinking off" now sends the lowest effort (`low`) instead of `none`, because LM Studio ignores `none` for that model and would put the thinking into the answer without a marker; the model thinks a little, the answer stays clean, and the request view says that off is not fully possible there. A backend or model family this plugin does not know yet no longer raises an error: the request view names it and falls back to the standard fields. Nothing else in the copied building blocks reaches this plugin.
- **The task rows in the crew panel show their state with the shared status icons instead of special characters.** Running tasks show the spinning loader, finished ones a check mark, failed ones a cross, stale ones a warning triangle; waiting and skipped tasks get a neutral dashed or minus circle. Colour is never the only signal: every icon carries the status text as its label, and the row text still names the status. With reduced motion switched on, the loader stands still.

## [0.19.0] — 2026-10-14

### Changed

- **A run refused because of the LLM Endpoint Manager now says why.** Instead of "Start LM Studio, then run again", the notice names the manager's reason: no endpoint available, a missing API key, a switched-off endpoint, or one that does not answer (a text per reason, English and German, each saying where to fix it). The run log carries the manager's code in brackets. Without the manager nothing changes.
- Kit pins raised to `obsidian-kit` 0.60.1 and `code-kit` 0.27.1 (from 0.59.1 and 0.24.0). Visible effects of the skipped releases (obsidian-kit 0.60.0, 0.60.1; code-kit 0.25.0, 0.26.0, 0.27.0, 0.27.1): a hint about discarded request settings lists them sorted instead of in stored order; the endpoint picker keeps the reason when an explicitly chosen endpoint is switched off or has no token (see the notice change below). Nothing else in the copied building blocks reaches this plugin.

### Added

- **Command "Show crew folder in the file explorer".** Takes you to the crew root so you can share a crew by copying its files (a crew is Markdown; there is no import or export dialog by design). If the folder is hidden by the "Hide crew folder" setting, or does not exist yet, the command says so.

### Fixed

- The "Model not found" notice no longer sends you to a "default model" that does not exist: it now says to choose a model on the active endpoint row, or to check the model field in the agent note.

- The dialog that offers to finish a run after a crash no longer promises a commit. It says what happens: the run is marked as aborted, what it wrote stays in the vault, and “Undo last run” can take it back.

### Removed

- The setting **Verbose logging** (Settings → Advanced) is gone. It promised extra output in the developer console, but nothing ever read it. An old value in `data.json` is dropped on the next load.

## [0.18.0] — 2026-10-12

### Added

- **The panel's tab bar is the Kit's hub (obsidian-kit `hub`).** "Crews" and "History" now show an icon next to the label, carry the full tab semantics (screen readers announce a tab list, the active tab is marked), and can be reached with the keyboard: Left/Right arrow keys move between the tabs, Home/End jump to the first/last one (Tab enters the bar once; the other tabs are skipped). The bar wraps to a second line in a narrow sidebar instead of cutting a label off. The title and the status line with the one Cancel button stay where they were (title on top, status line at the bottom, for both tabs); the tab that is not shown is no longer drawn behind the scenes.
- **The "Thinking … N tokens" counter is back in the reasoning block of the live view.** While a model thinks, the heading of the folded reasoning shows the running token count again (it went missing when the live view moved to the Kit's stream area in 0.10.0).

### Fixed

- **The first run in a vault without a run folder no longer stops with a file error.** It affected crews created by hand: only "Install example crews" created the `runs/` folder under the crew folder, so the first run of a hand-made crew ended with "A file operation failed unexpectedly" before the model was called. The plugin now creates the folder itself.

### Changed

- Tests only: the run-time limits on `extractJson`/`extractText` (a fixed 500 ms) are replaced by the Kit's linearity probe (growth from 1 000 to 50 000), so a busy machine can no longer fail them.
- Kit pin raised to obsidian-kit 0.59.1 (code-kit stays 0.24.0). Visible in the settings: in the endpoint list the "move up" and "remove endpoint" buttons stay together, and the address and the model name stay fully visible at normal width; in a narrow window the block of model and buttons moves as a whole into a second row instead of the trash can standing alone or a name being cut off.
- **The live answer area keeps following the end when a large block arrives in one piece** (a paragraph, a table, a code block), as long as you are at the bottom. Before, one block taller than a few lines made it stop following after the first one; with small streamed pieces you never saw it. If you scroll up, you are still not pulled back down.
- Kit pins raised to obsidian-kit 0.57.0 / code-kit 0.24.0. The stored endpoint choice in `data.json` is cleaned by the kit's shared `sanitizeChoice` instead of a local copy (identical result: only non-empty strings survive), so nothing changes for you.
- The plugin's test double for the Obsidian API is now the kit's shared mock (tests only; no effect on the plugin).

## [0.17.0] — 2026-10-12

### Changed

- **The endpoint list speaks the Kit's wording (obsidian-kit 0.56.0, English and German).** The status tooltips and the address hints come from the shared texts now. Visible: "Timed out — …" reads "Timeout — …", an unreachable row without a known reason reads "Not reachable — <error text>" (before: "Not reachable."), and the hint "Looks like an example/placeholder address" reads "… example or placeholder address".
- **The model dropdown of an endpoint row has its empty choice back, now called "— (server picks)"** (before: "— no model chosen —"). Choosing it removes the model from the row, so a model chosen once can be taken back. Kit 0.55.0 had dropped the empty choice together with the global model; 0.56.0 restored it with this wording. The migration of an old global `defaultModel` into rows stays.
- **JSON in a model answer is found by the shared code-kit module `llm-json` (code-kit 0.23.0).** The last ```` ```json ```` fence still wins, typographic quotes and a trailing comma are still repaired, "output truncated" is still reported. Three behaviours change on purpose: (1) **an unclosed `<think>` now drops the rest of the answer** — a JSON behind it is no longer read (decided 2026-10-12: its brackets come from the thinking, not from the answer); a closed `<think>…</think>` in front is removed as before. (2) **Prose with brackets in front of the JSON is skipped** instead of failing the run with "no JSON"/"invalid JSON" (only text that parses counts as a candidate). (3) **A fence on one line (```` ```json {…}``` ````) is no block any more**; its JSON is still found in the whole text. Searching an answer built to defeat the search (`[` repeated 20 000 times and closed again, 40 000 escaped quotes) stays linear: 50 000 broken pairs take about 0.4 s.
- **Folder hiding comes from the Kit module `folder-hide`** (own copy removed). Same behaviour; the stylesheet is created in the main window's own realm, also with a pop-out window open.
- **The context window is read by the shared Kit function, and it times out (code-kit 0.23.0 `fetchModelContext`, obsidian-kit 0.56.1 `fetchEndpointContext`).** Same order as before (LM Studio first, then Ollama), same result (`contextLength: null` when nothing answers). New: **every attempt gives up after 5 seconds**; before, a server that accepted the connection and never answered held the start of a run. The key of the active endpoint goes along in both requests.
- **Under each reachable endpoint row that has a model, the settings show the context window the server reports** ("Context: loaded N · max M tokens", or only "max M" when the model is not loaded; nothing when the server names no number). The figure is fetched after the status check and kept per address and model; **Refresh model list** and closing the settings drop it.
- Kit pins: obsidian-kit 0.53.0 → 0.56.1, code-kit 0.21.1 → 0.23.0.
- Skipped Kit releases, user-visible: **long streamed answers render faster and leak less** — the DOM guard of the live ticker only walks the changed parts (obsidian-kit 0.54.0); reasoning blocks are stripped in linear time in the shared response check (code-kit 0.22.0); the index and embedding modules of code-kit 0.22.x are not used by this plugin.

## [0.16.0] — 2026-10-11

### Changed

- **Undo snapshots are now thinned by age instead of counted.** "Undo history depth" (default 15) now applies to the current day; snapshots of older days keep one per day for a week, then one per week (four weeks) and one per month (six months), and anything older is deleted. The oldest and the newest snapshot of a day always stay. **After the update, the first finished run applies this to your existing snapshots:** someone who ran daily and had 15 snapshots keeps about two of those from days 8 to 15. Rotation comes from the shared code-kit module `rotation` (code-kit 0.20.0).
- **Masking of secrets in notes catches more `Bearer` tokens (code-kit 0.21.0).** Tokens of eight characters or more are masked, regardless of case and including `=` in the token; plain prose such as "Bearer authentication" in a note is therefore sent to the model as `Bearer [redacted-token]` and restored in the answer.
- Kit 0.53.0 / code-kit 0.21.1.

### Fixed

- **A model answer with very many unclosed `<think>` tags no longer stalls the run.** Removing reasoning blocks from an answer took time quadratic in its length (50 000 unclosed tags: 5.6 s, measured); it now comes from the shared code-kit function `stripThinkBlocks` and takes a few milliseconds. Complete blocks are removed as before, an unclosed one stays in the text.

## [0.15.0] — 2026-10-10

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
