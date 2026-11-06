/**
 * Session-backed agent() — the subagent spawn, on opencode V2 primitives:
 *
 *   client.session.create({parentID, agent, model, permissions, metadata})
 *   client.session.prompt({sessionID, text})   // admits the user turn
 *   client.session.wait({sessionID})           // blocks for the agentic loop
 *   client.session.context({sessionID})        // settled transcript
 *
 * V2 has no per-prompt system/format override and no StructuredOutput tool:
 *  - the worker contract (verbatim return value) is a preamble on the prompt
 *    text (OpenCode 2.2.5 plugins cannot register agents), and
 *  - schema mode instructs the worker to reply with raw JSON only, which is
 *    parsed tolerantly here and retried on a fresh session (cap 5).
 *
 * Extraction mirrors the built-in subagent flow: fail on info.error / last
 * errored tool call, else findLast text part.
 */

import { CUSTOM_AGENT_NOTE_TEXT, WORKER_NOTE_SCHEMA, WORKER_PREAMBLE, worktreeNote } from "./prompts";
import type { AgentFn, AgentOptions } from "./runner";
import type { PermissionRule } from "./state";

const MAX_STRUCTURED_OUTPUT_RETRIES = 5;

// The SDK's generated types omit fields we read on purpose (structured output,
// error shapes, timestamps) — these payloads are consumed loosely.
// biome-ignore lint/suspicious/noExplicitAny: deliberate — loose SDK response shapes
type LooseRecord = Record<string, any>;

export interface OpencodeClient {
	session: {
		create(input: {
			parentID?: string;
			title?: string;
			agent?: string;
			model?: { id: string; providerID: string; variant?: string };
			metadata?: Record<string, unknown>;
			permissions?: PermissionRule[];
		}): Promise<LooseRecord>;
		prompt(input: { sessionID: string; text: string }): Promise<unknown>;
		wait(input: { sessionID: string }): Promise<void>;
		interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>;
		get(input: { sessionID: string }): Promise<LooseRecord>;
		context(input: { sessionID: string }): Promise<LooseRecord[]>;
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
		const session = await init.client.session.get({ sessionID: init.parentSessionID });
		const rec = session ?? {};
		if (rec.model?.id && rec.model?.providerID) {
			model = { providerID: rec.model.providerID, modelID: rec.model.id };
		}
		// inherit the parent session's deny rules (children run with them too)
		for (const rule of (rec.permissions ?? []) as PermissionRule[]) {
			if (rule && typeof rule === "object" && rule.effect === "deny") denies.push(rule);
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
 * Build the worker ruleset. Ordered last-match-wins, so the edit allow LEADS:
 * workers default to friction-free file edits (V1's workflow-subagent carried
 * `edit: allow`), while every deny — inherited parent denies, disallowedTools,
 * and the hard subagent-spawn deny — comes later and therefore wins.
 */
function workerRuleset(parent: ParentInfo, opts: AgentOptions): PermissionRule[] {
	const rules: PermissionRule[] = [{ action: "edit", resource: "*", effect: "allow" }];
	rules.push(...parent.denies);
	for (const tool of opts.disallowedTools ?? []) {
		if (typeof tool !== "string" || !tool.trim()) continue;
		rules.push({ action: tool.trim(), resource: "*", effect: "deny" });
	}
	rules.push({ action: "subagent", resource: "*", effect: "deny" });
	return rules;
}

interface PromptOutcome {
	info: LooseRecord;
	parts: Array<LooseRecord>;
}

/**
 * Tolerant JSON extraction from a worker's final text: strips code fences,
 * then scans for the first balanced JSON value. Returns undefined when no
 * complete value parses.
 */
function parseLooseJson(text: string): unknown {
	const trimmed = text.trim();
	const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
	for (let i = 0; i < unfenced.length; i++) {
		const opener = unfenced[i];
		if (opener !== "{" && opener !== "[") continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < unfenced.length; j++) {
			const ch = unfenced[j];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === opener) depth++;
			else if (ch === (opener === "{" ? "}" : "]")) {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(unfenced.slice(i, j + 1));
					} catch {
						break; // torn value — try the next opener
					}
				}
			}
		}
	}
	return undefined;
}

/**
 * One worker turn: create a child session, submit the prompt (worker preamble
 * + task + mode notes), wait for the loop to settle, and read the transcript.
 */
async function promptOnce(
	init: SessionAgentInit,
	sessionID: string,
	prompt: string,
	opts: AgentOptions,
): Promise<PromptOutcome> {
	const sections: string[] = [];
	// The worker contract rides on the prompt (V2 has no per-session system
	// override from plugins): default workers get the full preamble; custom
	// agentTypes keep their own system prompt and get the shorter note.
	if (!opts.agentType || opts.agentType === WORKER_DEFAULT_AGENT) sections.push(WORKER_PREAMBLE);
	sections.push(prompt);
	if (opts.schema) {
		sections.push(`${WORKER_NOTE_SCHEMA}\n\nReply with JSON matching this schema:\n${JSON.stringify(opts.schema)}`);
	} else if (opts.agentType && opts.agentType !== WORKER_DEFAULT_AGENT) {
		sections.push(CUSTOM_AGENT_NOTE_TEXT);
	}

	await init.client.session.prompt({ sessionID, text: sections.join("\n\n") });
	await init.client.session.wait({ sessionID });
	const messages = await init.client.session.context({ sessionID });
	const last = messages.findLast((m) => m?.type === "assistant") ?? {};
	return { info: last, parts: Array.isArray(last.content) ? last.content : [] };
}

/** Set when the stall watchdog interrupted the session (distinct from user abort). */
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
 * promptOnce + stall watchdog: poll the session's transcript for activity;
 * when nothing has moved for stallMs, interrupt the session (promptOnce then
 * settles) and raise WorkflowStallError so the caller retries on a fresh
 * session. stallMs <= 0 disables the watchdog.
 */
async function promptWithStallWatch(
	init: SessionAgentInit,
	sessionID: string,
	prompt: string,
	opts: AgentOptions,
): Promise<PromptOutcome> {
	const stallMs = typeof opts.stallMs === "number" && opts.stallMs > 0 ? opts.stallMs : DEFAULT_STALL_MS;
	let lastActivity = Date.now();
	let stalled = false;
	const poll = setInterval(
		() => {
			void (async () => {
				try {
					const messages = await init.client.session.context({ sessionID });
					let newest = 0;
					for (const m of messages ?? []) {
						const t = m?.time;
						if (!t) continue;
						newest = Math.max(newest, t.created ?? 0, t.completed ?? 0, t.streamed ?? 0);
					}
					if (newest > 0) lastActivity = Math.max(lastActivity, newest);
				} catch {
					// transient poll failure — keep the previous activity stamp
				}
				if (!stalled && Date.now() - lastActivity > stallMs) {
					stalled = true;
					void init.client.session.interrupt({ sessionID, resume: false }).catch(() => {});
				}
			})();
		},
		Math.min(15_000, Math.max(5_000, Math.floor(stallMs / 6))),
	);
	try {
		const outcome = await promptOnce(init, sessionID, prompt, opts);
		if (stalled) throw new WorkflowStallError(stallMs);
		return outcome;
	} finally {
		clearInterval(poll);
	}
}

/** Text-mode extraction, like the built-in subagent flow. */
function extractText(outcome: PromptOutcome): { text: string } | { error: string } {
	const { info, parts } = outcome;
	if (info?.error) {
		const err = info.error as LooseRecord;
		return {
			error: `assistant error: ${err.name ?? err.message ?? "UnknownError"}: ${err.data?.message ?? err.message ?? ""}`,
		};
	}
	const failed = parts.findLast((p) => p?.type === "tool" && p?.state?.status === "error");
	if (failed) {
		return { error: `tool ${failed.name ?? failed.tool} failed: ${failed.state?.error ?? "unknown error"}` };
	}
	const text = parts.findLast((p) => p?.type === "text")?.text ?? "";
	return { text };
}

/** The agent used for workflow workers when a script does not name one. */
export const WORKER_DEFAULT_AGENT = "build";

/**
 * Create the session-backed AgentFn. One parent lookup per run; each agent()
 * call creates a fresh child session under the caller.
 */
export async function createSessionAgent(init: SessionAgentInit): Promise<AgentFn> {
	const parent = await fetchParentInfo(init);

	return async (prompt, opts, call) => {
		const promptParts: string[] = [prompt];
		if (opts.isolation === "worktree") {
			// worktree isolation is wired by the tool layer via opts; the note is
			// appended here when a worktree path was attached.
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
				const modelSpec = opts.model ? parseModelSpec(opts.model) : parent.model;
				const created = await init.client.session.create({
					parentID: init.parentSessionID,
					title: `${opts.label ?? prompt.slice(0, 40)} (@${opts.agentType ?? WORKER_DEFAULT_AGENT} workflow)`,
					agent: opts.agentType ?? WORKER_DEFAULT_AGENT,
					model: modelSpec ? { id: modelSpec.modelID, providerID: modelSpec.providerID } : undefined,
					permissions: workerRuleset(parent, opts),
					metadata: {
						runId: call.runId,
						agentIndex: call.index,
						agentId: call.agentId,
						label: opts.label,
						phase: opts.phase,
						attempt: attempt + 1,
					},
				});
				sessionID = created.id;
				call.report({ sessionId: sessionID });
			} catch (err) {
				call.report({ state: "error", error: `session create failed: ${(err as Error).message}` });
				return null;
			}

			const onAbort = () => {
				void init.client.session.interrupt({ sessionID, resume: false }).catch(() => {});
			};
			call.signal.addEventListener("abort", onAbort, { once: true });

			let outcome: PromptOutcome;
			try {
				outcome = await promptWithStallWatch(init, sessionID, finalPrompt, opts);
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
			const toolCalls = outcome.parts.filter((p) => p?.type === "tool").length;
			if (toolCalls) call.addToolCalls(toolCalls);

			if (opts.schema) {
				const extracted = extractText(outcome);
				if ("error" in extracted) {
					call.report({ state: "error", error: throttleHint(`schema output failed: ${extracted.error}`) });
					return null;
				}
				const structured = parseLooseJson(extracted.text);
				if (structured !== undefined) {
					return { value: structured };
				}
				if (attempt < MAX_STRUCTURED_OUTPUT_RETRIES) {
					attempt++;
					call.report({ state: "progress", attempt, lastAttemptReason: "schema validation" });
					continue; // fresh session, same prompt
				}
				call.report({
					state: "error",
					error: "schema output missing: worker finished without returning parseable JSON",
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

export { CUSTOM_AGENT_NOTE_TEXT };
