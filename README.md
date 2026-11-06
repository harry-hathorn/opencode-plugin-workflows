```text
                                  ██████████████████████
                                  ██╔════════════════╗██
                                  ██║  ● ─┬─▶ ● ● ●  ║██
                                  ██║     ╰─▶ ● ●    ║██
                                  ██╚════════════════╝██
                                  ██████████████████████

██╗    ██╗██████╗ ███████╗ ██████╗ ██████╗ ██╗  ██╗███████╗██╗      ██████╗ ██╗    ██╗██████╗ ███████╗███████╗
██║    ██║██╔══██╗██╔════╝██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██║     ██╔═══██╗██║    ██║██╔══██╗██╔════╝██╔════╝
██║ █╗ ██║██████╔╝█████╗  ██║   ██║██████╔╝█████╔╝ █████╗  ██║     ██║   ██║██║ █╗ ██║██████╔╝█████╗  ███████╗
██║███╗██║██╔═══╝ ██╔══╝  ██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██║     ██║   ██║██║███╗██║██╔═══╝ ██╔══╝  ╚════██║
╚███╔███╔╝██║     ███████╗╚██████╔╝██║  ██║██║  ██╗██║     ███████╗╚██████╔╝╚███╔███╔╝██║     ███████╗███████║
 ╚══╝╚══╝ ╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ╚═╝     ╚══════╝╚══════╝
```

```text
 opencode — workflows dashboard                                  <leader>d

 ◐ review-changes [wf_9f3k2m1a8b2c]                       12/16 agents
 running · 2m14s · 41.2k tok · filter: all
 ▸ Find (6/6)
   ↻ scan:src · 8.1k tok · 22s
   ✔ scan:test · 6.4k tok · 19s
 ▸ Verify (4/7)
   ✔ verify:null-deref · 5.2k tok · 31s
   ◐ verify:race · 3.9k tok · 12s
 ▸ Synthesize

 j/k select · return open · r runs · f filter · l logs · p pause · x kill · ? help · q close
```

# opencode-plugin-workflows

[![npm](https://img.shields.io/npm/v/opencode-plugin-workflows.svg)](https://www.npmjs.com/package/opencode-plugin-workflows)
[![CI](https://github.com/harry-hathorn/opencode-plugin-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/harry-hathorn/opencode-plugin-workflows/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[GitHub](https://github.com/harry-hathorn/opencode-plugin-workflows)** ·
**[Discussions](https://github.com/harry-hathorn/opencode-plugin-workflows/discussions)** ·
**[Issues](https://github.com/harry-hathorn/opencode-plugin-workflows/issues)**

**Deterministic multi-agent workflow orchestration for [opencode](https://opencode.ai) — a shareable plugin.**

Write a JavaScript orchestration script — `export const meta = {...}` plus plain
`agent()/parallel()/pipeline()/phase()/log()/budget()` — hand it to the `workflow` tool, and it
fans the work out over **real opencode subagent sessions**, journals every agent result, and
resumes killed or edited runs from cache. The model decides *what* to orchestrate; the script
decides *how*, with loops, barriers, and fan-out you can reason about.

> **Scripts are plain, portable JavaScript.** A meta literal plus `agent()/parallel()/pipeline()`
> — no proprietary surface. Save a script under `.opencode/workflows/` and it becomes a named
> workflow with its own slash command.

> **Workers are real sessions, not prompts-in-a-trenchcoat.** Every `agent()` spawns a child
> session (the `build` agent, or a custom `agentType`) under the calling session, visible in the
> TUI, with its own tool loop, token usage, and permissions (subagent spawning denied, parent
> denies inherited). The verbatim-return worker contract rides on each worker prompt.

> **Every run leaves a journal.** Each agent's (prompt, opts) is chained into a cache key; kill,
> pause, edit the script, relaunch with `resumeFromRunId`, and the longest unchanged prefix
> replays from cache — zero tokens, instant.

```text
 script ──▶ compile ──▶ sandbox ──▶ runner ──▶ opencode sessions
(name /     acorn:      node:vm,    journal,   worker sessions
 inline /   meta must   hardened    chained    agents: real
 scriptPath be a pure   context —   cache      agentic loops
 + args)    literal,    no Date /   keys →     under the
            banned      Math.random resume;    caller, with
            syntax,     or code-gen; semaphore token usage
            determinism 30s sync    + caps +   + tool calls
            checks      watchdog    budget
```

> I stopped asking the model to *be careful* and started telling it exactly what to run.
> Determinism is what makes a forty-agent review debuggable: every run leaves a journal, and
> every journal can be replayed. — Harry

---

## Tools

| Surface | What it does |
| --- | --- |
| `workflow` tool | Compile + run a script — inline `script`, saved `name`, or `scriptPath`; `args` in, `resumeFromRunId` to resume. |
| `workflow_status` tool | List running + recent runs with live progress (agents done/total, tokens, phase, errors). The source of runIds. |
| `workflow_control` tool | Kill or pause a run by runId. Both abort in-flight agents; both keep completed results resumable. |
| Worker contract | The verbatim-return contract each worker runs under (prompt preamble in v0.4; workers default to the `build` agent). |
| `/workflows` + `/<name>` commands | One slash command per saved workflow, plus `/workflows` for status/kill via the tools above. |
| TUI dashboard | Inline status panel above the composer while a run is live, plus sidebar section and full-screen dashboard (`<leader>d`): live phase→agent tree, run switcher, filters, jump into any agent session, pause/kill. Loads with the same `plugins` entry — see [TUI dashboard](#tui-dashboard). |

## Quick start

```bash
npm i -D opencode-plugin-workflows
```

Add to `.opencode/opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "plugins": ["opencode-plugin-workflows"]
}
```

One entry loads every part — the tools and commands in the server, the sidebar section and
dashboard in the TUI. (Local checkout: `"file:///abs/path/to/opencode-plugin-workflows"`.)

Launching a workflow asks **once** — a permission prompt on the `workflow` action carrying
the run's name, description, script, and args (pre-allow it below to skip entirely):

```json
{
  "permissions": [{ "action": "workflow", "resource": "*", "effect": "allow" }]
}
```

Then ask the model to run one, or use the slash command for a saved workflow:

```text
> review the diff across correctness, security, and tests, then verify every finding
  against two skeptics before reporting it

> /review-changes
```

A first script — this is the whole format:

```js
export const meta = {
  name: 'top-files',
  description: 'List the largest files per directory',
  phases: [{ title: 'Scan' }, { title: 'Summarize' }],
}

phase('Scan')
const dirs = ['src', 'test']
const sizes = await parallel(dirs.map(d => () =>
  agent(`du -sh ${d} and report just the number`, { label: d, phase: 'Scan' })))

phase('Summarize')
return sizes.filter(Boolean).join('\n')
```

## Writing a workflow

**The meta block.** Every script must begin with `export const meta = {...}` as a **pure
literal** — no variables, calls, spreads, or interpolation. Required: `name`, `description`
(shown in the approval dialog). Optional: `whenToUse`, `phases: [{title, detail?, model?}]`.
Use the same phase titles in `meta.phases` as in `phase()` calls — they group progress exactly.

**The body is plain JavaScript, not TypeScript** — type annotations fail to parse. It runs in an
async context (`await` works at top level), with these hooks:

| Hook | Signature | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?) → Promise<any>` | Spawn a subagent. Text mode returns its final text verbatim; `schema` mode returns a validated object. `null` on terminal failure or user skip — `.filter(Boolean)`. |
| `parallel` | `parallel(thunks) → Promise<any[]>` | **Barrier** — awaits all; a failed thunk resolves `null`; the call never rejects. Use only when the next step needs *all* results (dedup, merge, early-exit on zero). |
| `pipeline` | `pipeline(items, ...stages) → Promise<any[]>` | **No barrier** — each item flows through all stages independently; wall-clock is the slowest chain, not the sum. The default for multi-stage work. A stage that throws drops that item to `null` and skips its remaining stages. Later stages get `(prevResult, originalItem, index)`. |
| `phase` | `phase(title)` | Start a progress group; subsequent agents file under it. Inside `pipeline`/`parallel` stages, pass `opts.phase` instead — the global is racy under concurrency. |
| `log` | `log(message)` | Narrator line in the live progress view. |
| `args` | `any` | The tool call's `args` input, verbatim. Pass real JSON values, not a JSON-encoded string. |
| `budget` | `{total, spent(), remaining()}` | Output-token pool for the run. `total` is `null` unless the plugin option `budgetTotal` is set; `remaining()` is `Infinity` uncapped. A **hard** ceiling: `agent()` throws past it. |
| `workflow` | `workflow(nameOrRef, args?)` | Run a saved workflow (by name) or `{scriptPath}` inline as a sub-step. The child shares this run's caps, journal, abort signal, and budget. Nesting is one level — `workflow()` inside a child throws. |

**`agent()` options:**

| Option | Effect |
| --- | --- |
| `label` | Display label in progress and journal. |
| `phase` | Explicit progress group (use inside stages). |
| `schema` | JSON Schema (`{type:'object', ...}`, `required ⊆ properties`) — the worker must reply with raw JSON matching it; the plugin parses, validates, and retries on a fresh session (cap 5). |
| `model` | `"provider/model"` for this call only. Omit to inherit the session model — almost always right. |
| `effort` | Reasoning-effort override; omit to inherit. |
| `agentType` | Custom agent instead of the default `build` agent; composes with `schema`. |
| `disallowedTools` | Per-call deny list for the worker. |
| `stallMs` | Stall-watchdog override (default 180 000 ms; ≤ 0 disables). |
| `isolation` | `'worktree'` — accepted in v0.1 but runs in the shared directory; see [limitations](#limitations-pre-10). |

**Determinism is enforced, not requested.** `Date.now()`, `Math.random()`, and argless
`new Date()` **throw** inside a script — they would break resume. Pass timestamps in via `args`,
stamp results after the run returns, and vary prompts by index. There is no filesystem or Node
API access; the sandbox runs with code generation off and dangerous globals deleted.

**Caps.** Concurrency is `min(16, max(2, cpus − 2))` concurrent agents (override:
`OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS`); 1000 agents per run; 4096 items per
`parallel()`/`pipeline()` call — excess is an explicit error, never silent truncation.

A fuller shape — find across dimensions, then adversarially verify each finding (barrier to
dedup and early-exit; pipeline for the verify chain):

```js
export const meta = {
  name: 'review-changes',
  description: 'Review the diff across dimensions, verify each finding with skeptics',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

const FINDINGS = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' } },
    required: ['title', 'file', 'detail'] } } },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real', 'reason'],
}

phase('Find')
const dims = ['correctness', 'security', 'performance', 'tests']
const found = (await parallel(dims.map(d => () =>
  agent(`Review the current diff for ${d} issues.`, { phase: 'Find', schema: FINDINGS }))
)).filter(Boolean).flatMap(r => r.findings)
log(`${found.length} findings across ${dims.length} dimensions`)
if (!found.length) return 'no findings'

phase('Verify')
const verified = await pipeline(found,
  f => agent(`Adversarially verify this finding — try to refute it. Default to real=false if uncertain.\n${f.title} (${f.file}): ${f.detail}`,
    { label: `verify:${f.title}`, phase: 'Verify', schema: VERDICT }),
  (v, f) => (v && v.real ? { ...f, reason: v.reason } : null))

phase('Synthesize')
return verified.filter(Boolean)
```

**Scale with `budget`, not vibes.** When the plugin option `budgetTotal` is set, loops can grow
to the ceiling instead of a hardcoded N:

```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const r = await agent('Find bugs in this codebase.', { schema: BUGS_SCHEMA })
  bugs.push(...r.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining() / 1000)}k tokens remaining`)
}
```

## Kill, pause & resume

Every launched run persists its script and a `journal.jsonl` under
`~/.local/share/opencode/workflows/<runId>/`. `workflow_status` lists runs; `workflow_control`
kills or pauses by runId (workers get aborted; completed results stay journaled). Resume with:

```js
// the tool result of every run includes scriptPath + runId — feed them back:
workflow({ scriptPath: '~/.local/share/opencode/workflows/wf_…/script.js', resumeFromRunId: 'wf_…' })
```

The journal chains cache keys — `sha256(prompt ∥ canonicalOpts ∥ previousKey)` — so the
**longest unchanged prefix** of agent calls replays from cache; the first edited or new call and
everything after it runs live. Same script + same args is a 100% cache hit. `label`/`phase` are
excluded from the key: relabel freely, reword a prompt and everything downstream re-runs.

Workers that stall (no session activity for 180 s by default) are aborted and retried on a
fresh session, up to 5 attempts; rate-limit-shaped terminal errors are tagged with a
throttling hint and the run stays resumable.

## TUI dashboard

The package ships two entries: the **server half** (tools, commands) and a **TUI half**
(`opencode-plugin-workflows/tui`) that renders inside the opencode TUI. Registering the
package once under `plugins` loads both — the TUI loads the TUI parts of every plugin its
server loads:

```json
{
  "plugins": ["opencode-plugin-workflows"]
}
```

**Sidebar.** Sessions that have run workflows get a Workflows section (between LSP and Todo):
the latest run — status glyph, `name [runId]`, agents done/total, tokens, current phase,
elapsed — plus up to two recent settled runs. Click it to open the dashboard. It appears only
when there is something to show.

**Inline panel.** While a run is live, a one-line strip appears just above the composer — the
bullet. Press `<leader>d` (or the palette's "Workflows: status panel") to highlight it, `enter`
to expand a bordered status card, `enter` again for the full dashboard:

```text
 ❯ verify-slow                                                  3/4 agents · 8.4s
   enter expand · x stop · p pause · esc back
```

```text
 ╭──────────────────────────────────────────────────────────╮
 │◐ verify-slow                        3/4 agents · 0 tok · 8.4s│
 │Phases                run · 4 agents                        │
 │❯ 1 run 3/4           ✔ agent-a · 1.2k tok · 22s            │
 │                      ◐ agent-b · 0.9k tok · 12s            │
 │j/k phase · enter full view · x kill · p pause · esc back   │
 ╰──────────────────────────────────────────────────────────╯
```

| key | action |
| --- | --- |
| `<leader>d` / palette "Workflows: status panel" | highlight the strip |
| `enter` | strip → card → full dashboard |
| `j` / `k`, `g` / `G` | move the phase cursor (card) |
| `x` / `p` | kill / pause the run (confirmation dialog) |
| `esc` / `←` | card → strip → composer, one level per press |

The panel exists only while a run is live — it disappears the moment the run settles. The
composer itself is the stock one, untouched: the panel is appended above it through the
`session.composer.top` slot.

**Dashboard.** Open with `<leader>d` (default leader: `ctrl+x`), the command palette
("Workflows: dashboard"), or `enter` on the inline card. Full-screen and keyboard-driven:

```text
 ◐ review-changes [wf_9f3k2m1a8b2c]                       12/16 agents
 running · 2m14s · 41.2k tok · filter: all
 ▸ Find (6/6)
   ↻ scan:src · 8.1k tok · 22s
   ✔ scan:test · 6.4k tok · 19s
 ▸ Verify (4/7)
   ✔ verify:null-deref · 5.2k tok · 31s
   ◐ verify:race · 3.9k tok · 12s
 ▸ Synthesize

 j/k select · return open · r runs · f filter · l logs · p pause · x kill · ? help · q close
```

| key | action |
| --- | --- |
| `j` / `k`, `g` / `G` | next / previous agent · first / last |
| `enter` | jump into the selected agent's session (`q` from there returns) |
| `r` | run switcher — live runs first, then recent settled runs |
| `f` | cycle filter: all → running → done → error |
| `l` | toggle narrator `log()` lines (hidden by default) |
| `p` / `x` | pause / kill the run (confirmation dialog) |
| `?` | help |
| `q` / `esc` | close |

Agent glyphs: `◐` working · `✔` done · `↻` replayed from cache · `◦` skipped · `✗` error.
Run glyphs: `◐` running · `✔` completed · `✗` failed · `⊘` killed · `⏸` paused.

**Live runs are visible from launch.** The journal is written as agents start, so the sidebar
and dashboard surface a running run within a couple of seconds — with per-agent state — while
the workflow tool call is still in flight (token totals appear once it settles). Pause/kill
from the dashboard writes a control op the server picks up and applies to the live run; the
view settles to `⏸ paused` / `⊘ killed` when the run does, and the journal keeps completed
results resumable exactly like a `workflow_control` kill — `resumeFromRunId` as above.

## Configuration

| Knob | Where | Effect |
| --- | --- | --- |
| `["opencode-plugin-workflows", { "budgetTotal": 500000 }]` | `plugin` array | Hard output-token ceiling per run, surfaced to scripts as `budget.total`. |
| `"permission": { "workflow": "allow" }` | config | Pre-allow the launch dialog (it shows the full script once per run). |
| `OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | env | Override the concurrency cap. |
| `.opencode/workflows/*.js` | project | Saved workflows — one slash command each. |
| `~/.config/opencode/workflows/*.js` | global (`OPENCODE_CONFIG_DIR` respected) | Saved workflows; a global file wins over a project file with the same meta name. |

## Limitations (pre-1.0)

- **Worktree isolation is accepted, not isolated.** `isolation: 'worktree'` currently runs the
  agent in the shared directory (`isolation: 'remote'` throws). Managed `git worktree` isolation
  is planned.
- **Nesting is one level.** A `workflow()` child shares caps, journal, abort, and budget;
  `workflow()` inside that child throws.
- **Runs are synchronous tool calls** — no detached or background runs yet.
- **Live totals come from the journal.** Progress metadata streams via `session.tool.progress`
  events, but agent token/tool-call totals are only final at settle — the dashboard derives
  live state from the on-disk journal, and totals firm up when a run settles.
- **`/workflows` is model-mediated** (it relays `workflow_status`/`workflow_control`) — the
  dashboard is the human surface.

## Testing

Deterministic and hermetic — no LLM, no network. `agent()` is stubbed at the runner boundary;
the compiler, sandbox, journal chaining/resume, registry precedence, the nesting/budget/caps
pools, the control-bridge codec/drainer, and the TUI data derivations (evidence merge,
supersession, live-run discovery, dashboard flattening) are exercised directly (122 tests).

```bash
npm install
npm run build        # tsup → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run format       # biome format --write
npm test             # bun test
```

## Development

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). CI runs lint + typecheck + build +
test on every PR; releases publish to npm from the published GitHub release
(see [`.github/workflows/`](./.github/workflows/)).

```text
src/{index,tool,agent,compile,sandbox,runner,journal,registry,commands,status,prompts,control,state,paths}.ts
src/tui/{index,sidebar,dashboard,store,data}.ts(x)
test/{compile,sandbox,journal,runner,registry,control,tui-data}.test.ts
.github/workflows/{ci,release}.yml
```

## Community

- **[GitHub Discussions](https://github.com/harry-hathorn/opencode-plugin-workflows/discussions)** — Q&A, ideas, and show-and-tell. The best place to ask questions.
- **[GitHub Issues](https://github.com/harry-hathorn/opencode-plugin-workflows/issues)** — bugs and feature requests.
- Contributing — see [`CONTRIBUTING.md`](./CONTRIBUTING.md); vulnerability reports see [`SECURITY.md`](./SECURITY.md).
- Star the [repo](https://github.com/harry-hathorn/opencode-plugin-workflows) if it's useful.

## License

[MIT](./LICENSE) © harry-hathorn
