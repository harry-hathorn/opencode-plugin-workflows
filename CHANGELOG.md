# Changelog

All notable changes to opencode-plugin-workflows are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-12

### Added
- **`workflow` tool** — compile and run a workflow script (inline `script`, saved `name`, or `scriptPath`), with `args` passed in verbatim and `resumeFromRunId` to replay a previous run's unchanged prefix from cache.
- **Sandboxed, deterministic scripts.** acorn parse (`meta` must be a pure literal; banned syntax rejected) into a hardened `node:vm` context — code generation off, dangerous globals deleted, `Date.now()`/`Math.random()`/argless `new Date()` throw, 30 s sync watchdog.
- **Runtime API** — `agent(prompt, {label, phase, schema, model, effort, agentType, disallowedTools, stallMs, isolation})`, `parallel()` (barrier; failures resolve `null`), `pipeline()` (per-item, no barrier; a throwing stage drops that item), `phase()`, `log()`, `args`, `budget {total, spent(), remaining()}`, and one-level `workflow(nameOrRef, args)` nesting that shares caps, journal, abort signal, and budget.
- **Real session-backed agents.** Every `agent()` spawns a `workflow-subagent` session under the caller (visible in the TUI), with inherited deny rules and `task`/`todowrite` denied. Schema mode forces a validated StructuredOutput call with fresh-session retries (cap 5); a stall watchdog (180 s default, `stallMs` override) aborts and retries hung workers (cap 5) and tags rate-limit-shaped errors.
- **Journal + resume.** Chained cache keys (`sha256(prompt ∥ canonicalOpts ∥ prevKey)`) recorded to `journal.jsonl` per run; scripts are persisted per invocation for edit-and-resume loops. `workflow_status` / `workflow_control` list and kill/pause runs; both leave the run resumable.
- **Registry + slash commands.** Saved workflows discovered from `.opencode/workflows/` and `~/.config/opencode/workflows/` (global wins on name collision); each gets a slash command, plus `/workflows` for status/kill.
- **Launch gate.** One approval dialog per run showing the full script (`ctx.ask` self-gate, since plugin tools are ungated); pre-allow with `"permission": {"workflow": "allow"}`.
- CI (lint + typecheck + build + bun test) and an npm release workflow with a clean-room pack-and-import smoke gate.
