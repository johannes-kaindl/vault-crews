# Getting started

This walk-through takes you from a fresh install to a crew that has tagged a few notes — and to the undo that takes the tags away again. It needs about fifteen minutes and a local model server.

## 1. Start a local model server

Vault Crews talks to any OpenAI-compatible server. The default address is `http://localhost:1234/v1`, which is what [LM Studio](https://lmstudio.ai) uses out of the box; Ollama listens on `http://localhost:11434/v1`.

1. Start the server and load a chat model.
2. Enable CORS on the server, otherwise the live token stream is blocked. In LM Studio: Settings → Developer → *Enable CORS* (or `lms server start --cors`). Ollama needs the environment variable `OLLAMA_ORIGINS` to allow Obsidian. Without CORS the run still completes, but the panel shows "Waiting for output…" until the task is done — see [Troubleshooting](troubleshooting.md#the-panel-only-says-waiting-for-output).

New to local models? The [local LLM setup guide](https://uplink.jkaindl.de/llm-setup) covers server, model and access from other devices.

## 2. Install and enable the plugin

Follow one of the [install routes in the README](https://github.com/johannes-kaindl/vault-crews/blob/main/README.md#install), then enable **Vault Crews** under **Settings → Community plugins**. The plugin is desktop-only.

## 3. Check the connection and pick a model

Open **Settings → Community plugins → Vault Crews**. Under **Connection** the first row of **Endpoints** already holds `http://localhost:1234/v1`. Its status line should read **Connected** and the row is marked **Active**. If your server runs elsewhere, change the address there.

Every endpoint row carries its own model. Open the model dropdown of the active row and choose the model you loaded (**Refresh model list** re-reads it from the server). A row without a model makes every run stop with "Model not found".

If the **LLM Endpoint Manager** plugin is installed, the endpoint and model come from there instead; the settings then show its picker.

## 4. Install the example crews

Run the command **Install example crews** (or press the button of the same name under **Crews** in the settings). It creates the crew folder `_crews` with four ready-made teams — **Task-Triage**, **Daily-Briefing**, **Notiz-Tagger**, **Reifegrad-Tagger** — their agents, and the `runs.base` dashboard. A notice says "Example crews installed (N file(s))."; running it again changes nothing that already exists.

## 5. Prepare a few notes

The **Notiz-Tagger** crew reads notes in the folder `Notizen` that have no `tags` property and proposes two to four tags for each. Create the folder `Notizen` in your vault and put two or three short notes in it, without a `tags` property.

The folder is set in the team file `_crews/teams/notiz-tagger.md`, in two places that must match: the collector's `folder:` and the team's `write_scope:`. Change both if your notes live elsewhere.

## 6. Run the crew

1. Click the list icon in the ribbon, or run **Open crews panel**. The panel opens in the sidebar and lists the teams it found.
2. Press **Run** on **Notiz-Tagger**. Or use the command **Run crew: Notiz-Tagger**.
3. Watch the panel: each task shows Waiting → Running → Ok. With CORS enabled the model's reasoning and output stream in live.

When the run ends a notice reads "Notiz-Tagger: run completed — N file(s) written." Open one of your notes: it now has a `tags` property.

## 7. Read the log and undo

- **Open log** (in the panel's result card or the notice) opens `run.md`: what the crew collected, what the model proposed, what was written and what was skipped.
- **Undo** in the panel's **History** tab, or the command **Undo last run**, shows the team, the time and the files it would restore and asks before it acts. Confirm, and the notes are back in their pre-run state — no git repository needed.

That is the whole loop. To write your own crews, see [Writing your own crews](https://github.com/johannes-kaindl/vault-crews/blob/main/README.md#writing-your-own-crews) in the README.
