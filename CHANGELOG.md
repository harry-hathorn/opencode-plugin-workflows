# Changelog

All notable changes to opencode-plugin-workflows are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-06

### Changed
- **OpenCode V2 plugin API.** The plugin now ships as `Plugin.define({id, setup})` from
  `@opencode/plugin` (V1 plugin implementations do not run in OpenCode 2). Registration is one
  V2 `plugins` entry — the TUI half loads automatically; the separate `tui.json` registration
  and the `cli.json` workaround are gone. Requires opencode >= 2.
- **Tool layer** — JSON-Schema inputs (`ctx.tool.transform`), tool results carry `{content,
  metadata}`, live progress streams through `context.progress` metadata, and the launch gate is
  a `ctx.permission.assert` on the custom `workflow` action (pre-allow with
  `{"action":"workflow","resource":"*","effect":"allow"}`).
- **Workers** — OpenCode 2.2.5 plugins cannot register agents, so the `workflow-subagent`
  agent is gone: workers run as the `build` agent (or a custom `agentType`) with the
  verbatim-return contract as a prompt preamble. Worker model/agent are set at session create.
- **Schema mode** — no StructuredOutput tool in V2; workers reply with raw JSON matching the
  schema, parsed and validated by the plugin, retried on a fresh session (cap 5).
- **TUI** — ported to the V2 TUI plugin API: `sidebar.content` slot, `session.composer.top`
  slot (panel above the stock composer — V1's replace-mode `session_prompt` takeover has no V2
  equivalent), `ui.router` dashboard route, reactive `keymap.layer` commands, promise dialogs.
  Live evidence now comes from `session.tool.progress` / `session.tool.success` /
  `session.tool.failed` events plus the on-disk journal/snapshot store.
- **Keys** — the inline panel entry is `<leader>d` (V2 reserves `<leader>w` for closing a
  session tab, and the V1 `↓`-from-empty-composer entry relied on composer state the V2 API
  does not expose). `/wf-dashboard` (alias `/workflows`) and the palette commands remain.
- Slash commands (`/<workflow>` and `/workflows`) register through `ctx.command.transform` and
  expand `$ARGUMENTS` from the command's argument text themselves.

### Added
- V2 CI smoke test: the publishable tarball must import both entries and expose the
  `Plugin.define` shape (`{id, setup}`) with OpenTUI 0.8.2 peers installed.

### Fixed
- **Packaging (would have blocked the 0.4.0 publish)** — `dist` imports `@opencode/plugin`
  at runtime but it lived in devDependencies: the release smoke test (tarball installed into
  an empty dir) failed to resolve it, and npm consumers would too. `@opencode/plugin` is now
  a dependency and `solid-js` / `@opentui/core` / `@opentui/solid` are declared
  peerDependencies, matching the V2 plugin package layout. Verified by running the release
  smoke test locally against the packed tarball.
- **Workers get friction-free edits back** — V1's workflow-subagent carried `edit: allow`;
  the port's worker ruleset only added denies, so under an ask-by-default config workers
  stalled on permission prompts nobody answers (180s stall watchdog → interrupt → retry →
  agent failure after 5 attempts). The ruleset now leads with `{edit, *, allow}` and keeps
  every deny (inherited parent denies, `disallowedTools`, subagent-spawn) later in the list
  so denies still win under last-match-wins. Verified live: a child session reports exactly
  `[{edit,*,allow},{subagent,*,deny}]`.
- **Help dialog now quiets the dashboard keymap** — `dialog.show()` bypassed the dialog
  tracker, so `x`/`p` could stack a confirm on top of help and `q` closed both. The tracker
  gained `begin()`/`end()` and `openHelp` brackets its modal with them.
- Removed dead exports (`SUBAGENT_PROMPT_*`, `SUBAGENT_AGENT_*`, `CUSTOM_AGENT_NOTE_SCHEMA`)
  and a dead `delivery ?? "steer"` fallback.

### Verified
- End-to-end run on OpenCode 2.2.5: launch gate (pre-allowed path) → child session (build
  agent, correct parent, worker permissions) → prompt/wait/context → verbatim extraction →
  journal + snapshot on disk → `workflow_status` reads it back.
- Transcript tool items persist `state.metadata` (197/197 items in a live transcript), so
  the TUI store's settled-scan shape is correct. Note: through Code Mode, workflow calls are
  nested under the `execute` envelope without our result metadata — live journal + settled
  snapshot remain the canonical evidence paths (they are Code-Mode-independent and verified).
- One check remains manual: how much of the permission prompt's metadata (script preview
  etc.) the TUI renders — run any workflow without a pre-allow rule to see it.

## [0.3.0] - 2026-09-13

### Added
- **Inline workflow panel** in the TUI: while a run is live for the session, a one-line strip
  renders above the composer. `↓` from an empty composer (or `<leader>w`, or the palette's
  "Workflows: status panel") highlights it; `enter` expands a bordered status card — phases
  column with a `❯` cursor left, that phase's agents (windowed to four rows) right, coarse
  elapsed and totals in the header. `j`/`k`/`g`/`G` move the phase cursor, `x`/`p` kill/pause
  through the control bridge (confirmation dialog), `enter` opens the full dashboard, and
  `esc`/`←` backs out one level at a time. The panel exists only while a run is live and
  disappears at settle; editing is untouched (`↓` keeps its normal meaning whenever the
  composer has text, and the composer is the stock one, re-rendered by the plugin around the
  panel via the `session_prompt` slot).
- Unit tests for the inline view derivation (phase bucketing, synthetic `run`/`prep` buckets,
  cached/skipped counting, identity carry-through).

### Changed
- **Resumed runs append their own `launched` journal row** after replicating the prior
  journal, so live views report the resume's elapsed time instead of the original run's age.
  The TUI's journal parser takes the last `launched` row as the start. Legacy journals with a
  single `launched` row parse unchanged.

## [0.2.0] - 2026-09-13

### Added
- **TUI half — `opencode-plugin-workflows/tui`.** A second entry that renders inside the opencode TUI (register it in a `tui.json`; the TUI process does not read the `opencode.json` plugin array).
- **Sidebar section.** Sessions that ran workflows get a Workflows section (between LSP and Todo): latest run with status glyph, agents done/total, tokens, phase, elapsed — plus up to two recent settled runs. Click to open the dashboard; hidden without evidence.
- **Full-screen dashboard** — `<leader>w` (default leader `ctrl+x`) or the palette command "Workflows: dashboard". Phase→agent tree with per-phase counts and agent lines (state glyph, tokens, duration, attempt/cached/skipped chips, error and result previews), run switcher (`r`), filter cycle (`f`: all/running/done/error), narrator log toggle (`l`), help (`?`), and `enter` to jump into any agent's session with a return route.
- **Kill/pause from the TUI** (`x`/`p`, confirmation dialog) via a control bridge: the TUI appends a validated op to the run's `control.jsonl`; the server drains and applies it to the live run. Same semantics as `workflow_control` — completed results stay resumable. The server-side drainer is idempotent (byte offsets, torn-tail buffering, op dedupe) and shared by the tool and the bridge.
- **Live-run discovery from journals.** Workflow tool parts only become visible when the tool call settles on current opencode builds — the store also scans run dirs for a journal without a snapshot (journal rows land on disk synchronously as agents start), so runs are visible from launch with per-agent state. Child sessions created mid-run are attributed via their `{runId, agentId}` session metadata.
- **Release smoke gate** now installs and imports both entries (`.` and `./tui`) from the packed tarball in a clean room, asserting each export's shape.

### Changed
- **Journal rows carry `ts`** (epoch ms) on `launched`/`started`/`result`/`failed`, and `failed` rows carry the agent-reported error — powering live discovery and post-hoc reads. Legacy journals without `ts` still resume.
- **Snapshots carry the settled progress tree** — `rows` plus `nested` child arrays for `workflow()` sub-runs — so history renders identically to the live view.
- **Tool-part metadata carries `workflowName` + `nested`** both during progress and on the settled result, keeping the TUI's shapes identical before and after settle.
- **Worker session metadata** now includes `agentId` and `attempt`, correlating agent rows to their sessions across retries.

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
