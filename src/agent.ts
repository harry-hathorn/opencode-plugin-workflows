/**
 * Session-backed agent() — the subagent spawn, on opencode primitives:
 *
 *   client.session.create({parentID, agent: "workflow-subagent", permission})
 *   client.session.prompt({parts, format?})  // blocks for the whole agentic loop
 *
 * Extraction mirrors the built-in task tool (packages/opencode/src/tool/task.ts):
 * fail on info.error / last errored tool part, else findLast text part.
 * Structured mode reads (info as any).structured and retries on
 * StructuredOutputError with a fresh session (server retryCount is dead code).
 */

import { CUSTOM_AGENT_NOTE_SCHEMA, CUSTOM_AGENT_NOTE_TEXT, SUBAGENT_AGENT_NAME, worktreeNote } from "./prompts";
import type { AgentFn, AgentOptions } from "./runner";
import type { PermissionRule } from "./state";

const MAX_STRUCTURED_OUTPUT_RETRIES = 5;

// The SDK's generated types omit fields we read on purpose (structured output,
// error shapes, timestamps) — these payloads are consumed loosely.
// biome-ignore lint/suspicious/noExplicitAny: deliberate — loose SDK response shapes
type LooseRecord = Record<string, any>;

export interface OpencodeClient {
	session: {
		create(args: { body: Record<string, unknown> }): Promise<{ data: { id: string } }>;
		prompt(args: {
			path: { id: string };
			body: Record<string, unknown>;
		}): Promise<{ data: { info: LooseRecord; parts: Array<LooseRecord> } }>;
		abort(args: { path: { id: string } }): Promise<unknown>;
		get(args: { path: { id: string } }): Promise<{ data: LooseRecord }>;
		messages(args: {
			path: { id: string };
		}): Promise<{ data: Array<{ info: LooseRecord; parts: Array<LooseRecord> }> }>;
	};
}

export interface SessionAgentInit {
	client: OpencodeClient;
	parentSessionID: string;
	directory: string;
	worktree: string;
}

interface ParentInfo {
	model?: { providerID: string; modelID: string };
	denies: PermissionRule[];
}

async function fetchParentInfo(init: SessionAgentInit): Promise<ParentInfo> {
	const denies: PermissionRule[] = [];
	let model: ParentInfo["model"];
	try {
		const res = await init.client.session.get({ path: { id: init.parentSessionID } });
		const session = res.data ?? {};
		if (session.modelID && session.model?.providerID) {
			model = { providerID: session.model.providerID, modelID: session.modelID };
		} else if (session.model?.modelID) {
			model = { providerID: session.model.providerID, modelID: session.model.modelID };
		}
		// inherit the parent session's deny rules (deriveSubagentSessionPermission)
		for (const rule of (session.permission ?? []) as PermissionRule[]) {
			if (rule && typeof rule === "object" && (rule.action === "deny" || rule.permission === "external_directory")) {
				denies.push(rule);
			}
		}
	} catch {
		// parent session unreadable — proceed with defaults
	}
	return { model, denies };
}

/** Parse "provider/model" → {providerID, modelID}; null when not that shape. */
function parseModelSpec(spec: string): { providerID: string; modelID: string } | null {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx >= spec.length - 1) return null;
	return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) };
}

/**
 * Build the worker ruleset: inherited denies + external_directory rules,
 * disallowedTools denies, and hard denies for task/todowrite (workflow children
 * cannot spawn tasks or write todos — keeps the workflow tree flat and free
 * of runaway nested runs).
 */
function workerRuleset(parent: ParentInfo, opts: AgentOptions): PermissionRule[] {
	const rules: PermissionRule[] = [...parent.denies];
	for (const tool of opts.disallowedTools ?? []) {
		if (typeof tool !== "string" || !tool.trim()) continue;
		rules.push({ permission: tool.trim(), pattern: "*", action: "deny" });
	}
	rules.push({ permission: "task", pattern: "*", action: "deny" });
	rules.push({ permission: "todowrite", pattern: "*", action: "deny" });
	return rules;
}

interface PromptOutcome {
	info: LooseRecord;
	parts: Array<LooseRecord>;
}

async function promptOnce(
	init: SessionAgentInit,
	sessionID: string,
	prompt: string,
	opts: AgentOptions,
	parent: ParentInfo,
): Promise<PromptOutcome> {
	const body: Record<string, unknown> = {
		parts: [{ type: "text", text: prompt }],
	};
	const model = opts.model ? parseModelSpec(opts.model) : parent.model;
	if (model) body.model = model;
	if (opts.schema) {
		body.format = { type: "json_schema", schema: opts.schema };
	}
	// PromptInput.system APPENDS to the agent's system prompt:
	//  - schema mode → the schema note (MUST call StructuredOutput exactly once)
	//  - custom agentType in text mode → the custom-agent note (verbatim return value)
	if (opts.schema) {
		body.system = CUSTOM_AGENT_NOTE_SCHEMA;
	} else if (opts.agentType && opts.agentType !== SUBAGENT_AGENT_NAME) {
		body.system = CUSTOM_AGENT_NOTE_TEXT;
	}
	const res = await init.client.session.prompt({ path: { id: sessionID }, body });
	return { info: res.data.info, parts: res.data.parts };
}

/** Set when the stall watchdog aborted the session (distinct from user abort). */
class WorkflowStallError extends Error {
	constructor(stallMs: number) {
		super(`agent stalled: no session activity for ${stallMs}ms`);
		this.name = "WorkflowStallError";
	}
}

const THROTTLE_RE = /rate.?limit|429|too many requests|quota|overloaded/i;
/** Terminal-error decorator: flag provider throttling when the message smells like it. */
function throttleHint(msg: string): string {
	return THROTTLE_RE.test(msg) ? `${msg} [provider throttling suspected — the workflow can be resumed]` : msg;
}

const DEFAULT_STALL_MS = 180_000;
const MAX_STALL_RETRIES = 5;

/**
 * promptOnce + stall watchdog: poll the session's message list for activity;
 * when nothing has moved for stallMs, abort the session (promptOnce then
 * settles) and raise WorkflowStallError so the caller retries on a fresh
 * session. stallMs <= 0 disables the watchdog.
 */
async function promptWithStallWatch(
	init: SessionAgentInit,
	sessionID: string,
	prompt: string,
	opts: AgentOptions,
	parent: ParentInfo,
): Promise<PromptOutcome> {
	const stallMs = typeof opts.stallMs === "number" && opts.stallMs > 0 ? opts.stallMs : DEFAULT_STALL_MS;
	let lastActivity = Date.now();
	let stalled = false;
	const poll = setInterval(
		() => {
			void (async () => {
				try {
					const res = await init.client.session.messages({ path: { id: sessionID } });
					let newest = 0;
					for (const m of res.data ?? []) {
						const t = m.info?.time;
						if (!t) continue;
						newest = Math.max(newest, t.created ?? 0, t.completed ?? 0);
					}
					if (newest > 0) lastActivity = Math.max(lastActivity, newest);
				} catch {
					// transient poll failure — keep the previous activity stamp
				}
				if (!stalled && Date.now() - lastActivity > stallMs) {
					stalled = true;
					void init.client.session.abort({ path: { id: sessionID } }).catch(() => {});
				}
			})();
		},
		Math.min(15_000, Math.max(5_000, Math.floor(stallMs / 6))),
	);
	try {
		const outcome = await promptOnce(init, sessionID, prompt, opts, parent);
		if (stalled) throw new WorkflowStallError(stallMs);
		return outcome;
	} finally {
		clearInterval(poll);
	}
}

/** Text-mode extraction, exactly like the built-in task tool. */
function extractText(outcome: PromptOutcome): { text: string } | { error: string } {
	const { info, parts } = outcome;
	if (info?.error) {
		return { error: `assistant error: ${info.error.name ?? "UnknownError"}: ${info.error.data?.message ?? ""}` };
	}
	const failed = parts.findLast((p) => p.type === "tool" && p.state?.status === "error");
	if (failed) {
		return { error: `tool ${failed.tool} failed: ${failed.state?.error ?? "unknown error"}` };
	}
	const text = parts.findLast((p) => p.type === "text")?.text ?? "";
	return { text };
}

/**
 * Create the session-backed AgentFn. One parent lookup per run; each agent()
 * call creates a fresh child session under the caller.
 */
export async function createSessionAgent(init: SessionAgentInit): Promise<AgentFn> {
	const parent = await fetchParentInfo(init);

	return async (prompt, opts, call) => {
		const promptParts: string[] = [prompt];
		if (opts.isolation === "worktree") {
			// v1: prompt-framed worktree isolation is wired by the tool layer via
			// opts; the note is appended here when a worktree path was attached.
			const wtPath = (opts as AgentOptions & { worktreePath?: string }).worktreePath;
			if (wtPath) promptParts.push(worktreeNote(wtPath, init.directory));
		}
		const finalPrompt = promptParts.join("\n\n");

		let attempt = 0;
		let stallRetries = 0;
		// schema mode: retry with a fresh session per attempt (cap 5)
		for (;;) {
			let sessionID: string;
			try {
				const created = await init.client.session.create({
					body: {
						parentID: init.parentSessionID,
						title: `${opts.label ?? prompt.slice(0, 40)} (@${opts.agentType ?? SUBAGENT_AGENT_NAME} workflow)`,
						agent: opts.agentType ?? SUBAGENT_AGENT_NAME,
						permission: workerRuleset(parent, opts),
						metadata: {
							runId: call.runId,
							agentIndex: call.index,
							label: opts.label,
							phase: opts.phase,
						},
					},
				});
				sessionID = created.data.id;
				call.report({ sessionId: sessionID });
			} catch (err) {
				call.report({ state: "error", error: `session create failed: ${(err as Error).message}` });
				return null;
			}

			const onAbort = () => {
				void init.client.session.abort({ path: { id: sessionID } }).catch(() => {});
			};
			call.signal.addEventListener("abort", onAbort, { once: true });

			let outcome: PromptOutcome;
			try {
				outcome = await promptWithStallWatch(init, sessionID, finalPrompt, opts, parent);
			} catch (err) {
				call.signal.removeEventListener("abort", onAbort);
				if ((err as Error).name === "WorkflowStallError") {
					stallRetries++;
					if (stallRetries <= MAX_STALL_RETRIES) {
						call.report({ state: "progress", attempt: stallRetries, lastAttemptReason: "stall" });
						continue; // fresh session, same prompt
					}
					call.report({
						state: "error",
						error: `agent stalled ${stallRetries}× (no session activity) — provider may be throttling or the model hung`,
					});
					return null;
				}
				const msg = (err as Error).message ?? String(err);
				call.report({ state: "error", error: throttleHint(`prompt failed: ${msg}`) });
				return null;
			}
			call.signal.removeEventListener("abort", onAbort);

			// usage accounting
			const tokens = outcome.info?.tokens;
			if (tokens && typeof tokens.output === "number") call.addTokens(tokens.output);
			const toolCalls = outcome.parts.filter((p) => p.type === "tool").length;
			if (toolCalls) call.addToolCalls(toolCalls);

			if (opts.schema) {
				const structured = (outcome.info as { structured?: unknown }).structured;
				if (structured !== undefined) {
					return { value: structured };
				}
				const errName = outcome.info?.error?.name;
				if (errName === "StructuredOutputError" && attempt < MAX_STRUCTURED_OUTPUT_RETRIES) {
					attempt++;
					call.report({ state: "progress", attempt, lastAttemptReason: "schema validation" });
					continue; // fresh session, same prompt
				}
				if (outcome.info?.error) {
					call.report({
						state: "error",
						error: throttleHint(
							`schema output failed: ${outcome.info.error.name}: ${outcome.info.error.data?.message ?? ""}`,
						),
					});
					return null;
				}
				// structured missing without an error — treat as failure
				call.report({
					state: "error",
					error: "schema output missing: worker finished without calling StructuredOutput",
				});
				return null;
			}

			const extracted = extractText(outcome);
			if ("error" in extracted) {
				call.report({ state: "error", error: throttleHint(extracted.error) });
				return null;
			}
			return { value: extracted.text };
		}
	};
}

export { CUSTOM_AGENT_NOTE_SCHEMA, CUSTOM_AGENT_NOTE_TEXT };
