# Troubleshooting

Each entry starts with what you see — the wording is the plugin's own English text — then the cause and what to do. If yours is not here, see [Getting help](#getting-help). Every run also writes a log (`run.md`, next to it `state.json`) that names the failing step; **Open log** in the panel or the notice takes you there.

## No crews found

> No crews found — install the example crews first.

**Cause:** the crew folder holds no team. Teams are only picked up from `<crew root>/teams/` and agents from `<crew root>/agents/`.

**Fix:** run **Install example crews**, or put your own team file into `teams/` under the crew root (default `_crews`, see **Settings → Vault Crews → Crews**). If the panel instead says "N file(s) with a crew-kind: field sit directly in the crew folder. Crews are only picked up from teams/ and agents/.", move those files into the two subfolders.

## The run is refused before it starts

> Notiz-Tagger: run refused — Start LM Studio, then run again.

**Cause:** the plugin found no reachable endpoint. It tries the endpoints in the order of the list, skips the denied ones (port 8080 by default) and uses the first that answers.

**Fix:** start the server and load a model, then open **Settings → Vault Crews → Connection** and press **Check connections**. Each row says why it fails:

| Row status | Meaning |
|---|---|
| Connection refused — server not running or wrong port. | The server is off, or the port in the address is wrong. |
| Unknown host — typo in the address? | The host name does not resolve. |
| Timed out — network unreachable (wrong network / VPN off?). | The machine is not reachable from here. |
| Responds, but is not an OpenAI-compatible endpoint — wrong path/service? | Something answers, but it is not a chat-completions server. |
| Access denied — API key missing or invalid. | The server wants an API key. Enter it on that row. |

Local servers almost always need a port, for example `http://localhost:1234/v1`.

## Model not found

> Notiz-Tagger: run refused — Model not found — check the default model or the team's model field.

**Cause:** the active endpoint has no model chosen, or the chosen model is not loaded on the server. (The plugin has no global "default model" any more — the model belongs to the endpoint row. The notice text still says "default model"; it means that row.) The run log names the model: "Modell nicht geladen: …" or "Für diesen Endpunkt ist kein Modell gewählt".

**Fix:** in **Settings → Vault Crews → Connection** choose the model in the dropdown of the active row, press **Refresh model list** if it is missing, and load it on the server. An agent note may pin its own `model:` — that only counts when the active endpoint carries that model, otherwise the row's model is used.

## The panel only says Waiting for output

> Waiting for output…

**Cause:** the live token stream is blocked by CORS. Obsidian sends the origin `app://obsidian.md`, and the server refuses it. The run itself is not affected: the plugin falls back to a non-streaming request and the result arrives when the task is done.

**Fix:** in LM Studio enable CORS (Settings → Developer → *Enable CORS*, or `lms server start --cors`). For Ollama set `OLLAMA_ORIGINS` to allow the Obsidian origin and restart it.

## The collector found 0 matching notes

> Notiz-Tagger: the collector found 0 matching notes in Notizen — check the folder/filter.

**Cause:** the collector's `folder:` does not exist, is empty, or every note in it already satisfies the filter (for example `where_missing: [tags]` — all notes already have tags). No model call is made and nothing is written; the run ends as partial.

**Fix:** open the team file (`_crews/teams/<team>.md`) and check the collector's `folder:` and filter. Point `folder:` and `write_scope:` at the same folder — a proposal outside the write scope is discarded.

## The team or agent file has an error

> Task-Triage: run refused — The team or agent file has an error — check its fields.

**Cause:** the team or one of its agents does not parse: an unknown field value, a missing agent note, a `write_scope` that touches the denylist (`.obsidian/**`, `.git/**`, the crew root itself, dotfiles). The panel warns before you start: "This crew has a problem and will likely fail: …".

**Fix:** the run log lists every error with its file. Correct the fields, then run again.

## The model's output could not be parsed

> The model's output could not be parsed, even after one repair attempt.

**Cause:** the model did not return valid JSON for the task's schema, twice. Small models do this often. The raw answers are kept under `runs/<id>/artifacts/`.

**Fix:** use a larger or instruction-tuned model, or make the agent note's instruction shorter and more explicit.

## The answer was cut off

> The answer ran into the token limit and was cut off — raise max_tokens in the agent note.

**Cause:** the model hit its output limit before the answer was complete.

**Fix:** raise `max_tokens` in the agent note. If the input is the problem instead — "The input was too large for the model's context window." — collect fewer notes (`limit:` in the collector) or load the model with a larger context.

## The call took too long or the model went silent

> The call took too long and was stopped.
> The model stopped producing tokens.

**Cause:** the call ran into the **Call timeout** (300 s), or no new token arrived for the **Stall timeout** (60 s; only checked after the first data chunk, so model loading is never mistaken for a stall).

**Fix:** raise the timeouts under **Settings → Vault Crews → Advanced**, or use a faster model. Timeout changes apply from the next run.

## Too many proposed changes were rejected

> Too many proposed changes did not match the source material.
> The write limit for this run was reached.

**Cause:** the safety checks dropped more than half of a task's actions (the model invented paths or values that were not in the collected material), or the run hit **Max writes per run**. Nothing half-consistent is applied.

**Fix:** for the first, sharpen the agent's instruction or use a stronger model. For the second, raise **Max writes per run** under **Safety** — a team's own `max_writes` can only be lower than that setting.

## A run is already in progress

> A run is already in progress.

**Cause:** only one run at a time. If Obsidian closed unexpectedly during a run, an orphaned lock is left over instead.

**Fix:** wait for the running crew or use **Abort current run**. After a crash the plugin offers **Recover interrupted run** on the next start — **Finish orphaned run (keep partial changes)** commits what was written so far and clears the lock; the changes stay undoable.

## Undo warns that files were changed

> N file(s) were changed after the run — roll back anyway?

**Cause:** you edited a note after the run. Undo restores the pre-run state, so your later edit would be lost.

**Fix:** copy your edit out first, or confirm to roll back anyway. Notes the run created go to the Obsidian trash, never a hard delete.

## The model kept reasoning

> This model kept reasoning despite 'thinking: off' — suppression does not fully apply.

**Cause:** some models think whatever the request says. The run is not wrong, but reasoning tokens cost time.

**Fix:** none needed; pick a different model if the delay matters.

## Getting help

Still stuck? [Open an issue](https://github.com/johannes-kaindl/vault-crews/issues) with your Obsidian version, the plugin version (Settings → Community plugins), the server and model you use, and the `run.md` of the failing run (remove note content you do not want to share).
