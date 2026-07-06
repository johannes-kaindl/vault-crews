# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

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
