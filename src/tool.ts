/**
 * The `workflow` tool: input schema, script resolution (scriptPath > name > script), launch
 * self-gate via ctx.ask (plugin tools are ungated in opencode, so the tool
 * asks itself once per run; `permission: {"workflow": "allow"}` pre-allows),
 * per-invocation script persistence, execution, and result rendering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";
import { z } from "zod";
import { createSessionAgent, type OpencodeClient } from "./agent";
import { compileWorkflow, MAX_SCRIPT_CHARS, WorkflowCompileError } from "./compile";
import { isValidRunId, Journal, type LoadedJournal, newRunId, runDir, safeRunId } from "./journal";
import { agentCapError, resumeHint, WORKFLOW_TOOL_DESCRIPTION } from "./prompts";
import { discoverWorkflows, resolveWorkflow } from "./registry";
import {
	type AgentFn,
	cloneForSandbox,
	createSharedRunState,
	executeWorkflow,
	WorkflowAgentCapError,
	type WorkflowProgress,
} from "./runner";
import { type LiveRun, registerRun, unregisterRun } from "./state";
import { writeSnapshot } from "./status";

/** C0 controls minus \t\n\r, DEL, zero-width + bidi + line/paragraph separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is this regex's purpose
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/;
const RESULT_TRUNCATION = 8000;
const ASK_SCRIPT_PREVIEW = 8000;
const EMPTY_RESULT_RE = /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/;

export interface WorkflowToolDeps {
	client: OpencodeClient;
	directory: string;
	worktree: string;
	budgetTotal?: number | null;
}

/** `args` accepts any JSON; strings that look like JSON are coerced (§1). */
function coerceArgs(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim();
	if (!/^[[{"(-?\d]|^(true|false|null)/.test(trimmed)) return raw;
	try {
		return JSON.parse(trimmed);
	} catch {
		return raw;
	}
}

function readScriptFile(scriptPath: string): string {
	let resolved = scriptPath;
	if (scriptPath.startsWith("~/")) {
		resolved = path.join(process.env.HOME ?? "", scriptPath.slice(2));
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new WorkflowCompileError(`scriptPath not found: ${scriptPath}`);
	}
	if (stat.size > MAX_SCRIPT_CHARS) {
		throw new WorkflowCompileError(`scriptPath exceeds the ${MAX_SCRIPT_CHARS}-character limit.`);
	}
	return fs.readFileSync(resolved, "utf8");
}

function renderResult(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
	} catch {
		text = String(value);
	}
	return text.length > RESULT_TRUNCATION ? `${text.slice(0, RESULT_TRUNCATION)}…[truncated]` : text;
}

function countAgentStates(progress: WorkflowProgress) {
	let done = 0;
	let errored = 0;
	let empty = 0;
	for (const row of progress.rows) {
		if (row.type !== "workflow_agent") continue;
		if (row.state === "done") {
			done++;
			if (row.cached) continue;
			if (row.resultPreview !== undefined && EMPTY_RESULT_RE.test(row.resultPreview.trim())) empty++;
		}
		if (row.state === "error") errored++;
	}
	return { done, errored, empty };
}

function currentPhaseTitle(progress: WorkflowProgress): string | undefined {
	let last: string | undefined;
	for (const row of progress.rows) if (row.type === "workflow_phase") last = row.title;
	return last;
}

export function createWorkflowTools(deps: WorkflowToolDeps) {
	const workflowTool = {
		description: WORKFLOW_TOOL_DESCRIPTION,
		args: {
			script: z
				.string()
				.max(MAX_SCRIPT_CHARS)
				.optional()
				.describe(
					"Workflow script source (inline). Must begin with `export const meta = {...}` as a pure literal. Plain JavaScript, not TypeScript.",
				),
			name: z
				.string()
				.optional()
				.describe("Saved workflow name (from .opencode/workflows or ~/.config/opencode/workflows)"),
			scriptPath: z
				.string()
				.optional()
				.describe("Path to a workflow script on disk; takes precedence over script and name"),
			args: z
				.any()
				.optional()
				.describe(
					"Arguments for the workflow, exposed to the script as the global `args`. Pass actual JSON values, not a JSON-encoded string.",
				),
			resumeFromRunId: z
				.string()
				.regex(/^wf_[a-z0-9-]{6,}$/)
				.optional()
				.describe("Resume a previous run: completed agents (unchanged prompt+opts prefix) replay from cache"),
		} satisfies z.ZodRawShape,

		async execute(
			input: {
				script?: string;
				name?: string;
				scriptPath?: string;
				args?: unknown;
				resumeFromRunId?: string;
			},
			ctx: ToolContext,
		): Promise<ToolResult> {
			// Abort wiring FIRST: Esc/interrupt must never orphan live workers.
			const runCtrl = new AbortController();
			const onInterrupt = () => runCtrl.abort("interrupt");
			if (ctx.abort.aborted) onInterrupt();
			else ctx.abort.addEventListener("abort", onInterrupt, { once: true });

			try {
				const workflowArgs = coerceArgs(input.args);

				// --- resolve script: scriptPath > name > script ---
				let script: string;
				let resolvedName: string | undefined;
				if (input.scriptPath) {
					script = readScriptFile(input.scriptPath);
				} else if (input.name) {
					const hit = resolveWorkflow(input.name, deps.directory, deps.worktree);
					if (!hit) {
						const available = discoverWorkflows(deps.directory, deps.worktree).map((w) => w.name);
						throw new WorkflowCompileError(
							`Workflow "${input.name}" not found. Available: ${available.length ? available.join(", ") : "(none saved)"}`,
						);
					}
					script = hit.script;
					resolvedName = hit.saved.name;
				} else if (input.script) {
					if (CONTROL_CHARS.test(input.script)) {
						throw new WorkflowCompileError(
							"script contains control characters that would be hidden in the approval dialog",
						);
					}
					script = input.script;
				} else {
					throw new WorkflowCompileError(
						"Provide one of: script (inline source), name (saved workflow), or scriptPath (file on disk).",
					);
				}

				// --- compile: validates meta literal, banned syntax, determinism ---
				const compiled = compileWorkflow(script);
				const meta = compiled.meta;
				const displayName = resolvedName ?? meta.name;

				// --- resume state ---
				let resume: LoadedJournal | undefined;
				if (input.resumeFromRunId) {
					const safe = safeRunId(input.resumeFromRunId);
					if (!safe || !isValidRunId(input.resumeFromRunId)) {
						throw new WorkflowCompileError(`invalid resumeFromRunId: ${input.resumeFromRunId}`);
					}
					const prevJournal = path.join(runDir(safe), "journal.jsonl");
					resume = Journal.load(prevJournal);
					if (!resume.rows.length) {
						throw new WorkflowCompileError(
							`no journal found for run ${safe} — nothing to resume. Fallback: Read agent transcript files under ${runDir(safe)} and hand-author a continuation script.`,
						);
					}
				}

				// --- launch self-gate: one ask() per run, script shown for review ---
				if (!runCtrl.signal.aborted) {
					try {
						await ctx.ask({
							permission: "workflow",
							patterns: [resolvedName ?? "script"],
							always: ["*"],
							metadata: {
								title: `Run workflow: ${displayName}`,
								description: meta.description,
								script:
									script.length > ASK_SCRIPT_PREVIEW
										? `${script.slice(0, ASK_SCRIPT_PREVIEW)}\n…[truncated — full script in the tool call]`
										: script,
								args: workflowArgs,
								resumeFromRunId: input.resumeFromRunId,
							},
						});
					} catch {
						return {
							title: `workflow ${displayName}: rejected`,
							output:
								"Workflow launch was rejected by the user. Do not retry unless the user explicitly asks again.",
							metadata: { status: "rejected" },
						};
					}
				}

				// --- run identity + script persistence (only for launched runs) ---
				const runId = newRunId();
				const dir = runDir(runId);
				const scriptPath = path.join(dir, "script.js");
				try {
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(scriptPath, script, { mode: 0o600 });
				} catch (err) {
					throw new Error(`failed to persist workflow script: ${(err as Error).message}`);
				}

				// --- live-run registration ---
				let lastProgress: WorkflowProgress = {
					rows: [],
					agentCount: 0,
					totalTokens: 0,
					totalToolCalls: 0,
				};
				let status: LiveRun["status"] = "running";
				const liveRun: LiveRun = {
					runId,
					name: displayName,
					startedAt: Date.now(),
					parentSessionID: ctx.sessionID,
					abort: (reason: string) => runCtrl.abort(reason),
					getProgress: () => lastProgress,
					get status() {
						return status;
					},
				};
				registerRun(liveRun);

				const journal = new Journal(path.join(dir, "journal.jsonl"));
				const onProgress = (progress: WorkflowProgress) => {
					lastProgress = progress;
					const counts = countAgentStates(progress);
					const phase = currentPhaseTitle(progress);
					ctx.metadata({
						title: `workflow ${displayName} [${runId}]${phase ? ` — ${phase}` : ""}: ${counts.done}/${progress.agentCount} agents, ${progress.totalTokens} tokens`,
						metadata: { workflowProgress: progress, runId },
					});
				};

				try {
					const agent: AgentFn = await createSessionAgent({
						client: deps.client,
						parentSessionID: ctx.sessionID,
						directory: deps.directory,
						worktree: deps.worktree,
					});
					// workflow() nesting: children share the parent's caps, journal,
					// abort signal, and token budget (one level, enforced by the runner).
					const shared = createSharedRunState();
					const nestedWorkflow = async (
						nameOrRef: string | { scriptPath: string },
						childArgs: unknown,
					): Promise<unknown> => {
						let source: string;
						if (typeof nameOrRef === "string") {
							const hit = resolveWorkflow(nameOrRef, deps.directory, deps.worktree);
							if (!hit) {
								const names =
									discoverWorkflows(deps.directory, deps.worktree)
										.map((w) => w.name)
										.join(", ") || "(none)";
								throw new Error(`Workflow "${nameOrRef}" not found. Available: ${names}`);
							}
							source = hit.script;
						} else {
							source = readScriptFile(nameOrRef.scriptPath);
						}
						const childCompiled = compileWorkflow(source);
						const childName = childCompiled.meta.name;
						const childOutcome = await executeWorkflow({
							runId,
							compiled: childCompiled,
							args: childArgs,
							agent,
							journal,
							resume,
							signal: runCtrl.signal,
							budgetTotal: deps.budgetTotal ?? null,
							shared,
							onProgress: (progress) => {
								const counts = countAgentStates(progress);
								ctx.metadata({
									title: `workflow ▸ ${childName} [${runId}]: ${counts.done}/${progress.agentCount} agents, ${progress.totalTokens} tokens`,
									metadata: { workflowProgress: progress, runId },
								});
							},
						});
						if (childOutcome.status === "completed") return childOutcome.result;
						if (childOutcome.status === "failed" && childOutcome.error === agentCapError) {
							// fatal, run-global — escape the parent unchanged
							throw new WorkflowAgentCapError();
						}
						if (childOutcome.status === "killed" || childOutcome.status === "paused") {
							// name-tagged abort, recognized by the parent run's catch
							const reason = childOutcome.status === "paused" ? "user-pause" : "user-kill";
							const err = new Error(`Workflow aborted (${reason})`);
							err.name = "WorkflowAbortError";
							(err as Error & { reason?: string }).reason = reason;
							throw err;
						}
						throw new Error(
							`workflow('${childName}') failed${childOutcome.error ? `: ${childOutcome.error}` : ""}`,
						);
					};
					const outcome = await executeWorkflow({
						runId,
						compiled,
						args: workflowArgs,
						agent,
						journal,
						resume,
						onProgress,
						signal: runCtrl.signal,
						budgetTotal: deps.budgetTotal ?? null,
						shared,
						nestedWorkflow,
					});
					status = outcome.status;

					writeSnapshot({
						runId,
						name: displayName,
						description: meta.description,
						status: outcome.status,
						parentSessionID: ctx.sessionID,
						startedAt: liveRun.startedAt,
						durationMs: outcome.durationMs,
						scriptPath,
						agentCount: outcome.progress.agentCount,
						totalTokens: outcome.progress.totalTokens,
						totalToolCalls: outcome.progress.totalToolCalls,
						error: outcome.error,
						args: workflowArgs === undefined ? undefined : cloneForSandbox(workflowArgs),
					});

					const counts = countAgentStates(outcome.progress);
					const blocks: string[] = [];
					const headline =
						outcome.status === "completed"
							? `Workflow ${displayName} completed`
							: `Workflow ${displayName} ${outcome.status}`;
					blocks.push(`${headline} (runId: ${runId}, script persisted at ${scriptPath})`);

					if (outcome.status === "completed") {
						blocks.push(
							`<result>\n${renderResult(outcome.result)}\n</result>`,
							`<diagnostics>
Per-agent results: ${path.join(dir, "journal.jsonl")} — one {"type":"result",...} line per completed agent with its full return value.
If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.
To re-run with edited post-processing: workflow({scriptPath:'${scriptPath}', resumeFromRunId:'${runId}'}) — agents whose (prompt, opts) are unchanged replay from cache.
</diagnostics>`,
						);
					} else {
						blocks.push(
							`<recovery>
${outcome.error ?? "workflow did not complete"}
${resumeHint(scriptPath, runId, workflowArgs)}
</recovery>`,
						);
					}

					if (outcome.failures.length) {
						blocks.push(`<failures>\n${outcome.failures.join("\n")}\n</failures>`);
					}

					blocks.push(
						`<usage><agent_count>${outcome.progress.agentCount}</agent_count><subagent_tokens>${outcome.progress.totalTokens}</subagent_tokens><tool_uses>${outcome.progress.totalToolCalls}</tool_uses><duration_ms>${outcome.durationMs}</duration_ms></usage>`,
						`agents: ${counts.done} done, ${counts.errored} error, ${counts.empty} empty-result`,
					);

					return {
						title: `workflow ${displayName}: ${outcome.status}`,
						output: blocks.join("\n\n"),
						metadata: {
							runId,
							status: outcome.status,
							scriptPath,
							workflowProgress: outcome.progress,
						},
					};
				} finally {
					unregisterRun(runId);
				}
			} finally {
				ctx.abort.removeEventListener("abort", onInterrupt);
			}
		},
	};

	return { workflowTool };
}
