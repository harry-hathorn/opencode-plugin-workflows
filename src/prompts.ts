/**
 * Prompt & message catalog: tool description, subagent system prompts,
 * user-facing notes and error strings.
 *
 * Platform notes:
 *  - "Workflow" tool name → "workflow"
 *  - background task-notification semantics → synchronous tool call with live progress
 *  - "Agent tool" → "task tool"; SendUserMessage does not exist in opencode
 *  - ultracode keyword/session triggers are not ported in v1 (no keyword hook)
 */

/**
 * The `workflow` tool description sent to the model.
 * Port of WORKFLOWS-PROMPTS.md §1.1 with the opt-in gate, meta rule, and the
 * canonical pipeline example. Background/notification language adapted.
 */
export const WORKFLOW_TOOL_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. The tool call runs the script to completion — live phase/agent progress is streamed to the tool panel while it runs. Use /workflows to inspect runs.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call the workflow tool.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the task tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the approval dialog) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
\`\`\`
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
// Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.
\`\`\`

Resume: the tool result includes a runId. To resume after a pause, kill, or script edit, re-invoke with {scriptPath, resumeFromRunId} — the longest unchanged prefix of agent() calls returns cached results instantly. Date.now()/Math.random()/argless new Date() are unavailable in scripts (they would break resume).`;

/**
 * workflow-subagent system prompt, default text mode.
 * The "SendUserMessage" bullet is dropped — that tool does not exist in opencode.
 * Registered as the agent's `prompt` in the config hook (agent prompts REPLACE
 * the default system prompt).
 */
export const SUBAGENT_PROMPT_TEXT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Be concise. The script will parse your output.`;

/**
 * Worker contract for OpenCode V2, where plugins cannot register agents
 * (2.2.5): the preamble rides on each worker prompt instead of replacing a
 * system prompt. Same contract as SUBAGENT_PROMPT_TEXT.
 */
export const WORKER_PREAMBLE = `[workflow worker contract]
You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Be concise. The script will parse your output.`;

/**
 * Schema-mode worker contract for OpenCode V2: there is no StructuredOutput
 * tool, so the worker returns its answer as raw JSON in the final text
 * response and the orchestrator parses + validates it.
 */
export const WORKER_NOTE_SCHEMA = `[workflow worker contract — structured mode]
You are a subagent spawned by a workflow orchestration script. Your final answer MUST be a single raw JSON value conforming to the JSON schema below.
- Do your work (Read files, run commands, etc.), then reply with ONLY the JSON value — no code fences, no prose, no markdown.
- The script parses your final text response as JSON; anything else is a validation failure and the task is retried.
- After the JSON value, end your turn. No acknowledgment needed.`;

/**
 * workflow-subagent system prompt, schema mode.
 * In opencode this is delivered by REPLACING the text-mode prompt: schema-mode
 * workers run as the same agent but the schema note is appended via the prompt's
 * `system` parameter (PromptInput.system appends to the agent prompt).
 */
export const SUBAGENT_PROMPT_SCHEMA = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call StructuredOutput with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.
- If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.
- After calling StructuredOutput successfully, end your turn. No acknowledgment needed.`;

/** Note appended to custom agentType prompts, text mode. */
export const CUSTOM_AGENT_NOTE_TEXT = `---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`;

/** Note appended to custom agentType prompts, schema mode. */
export const CUSTOM_AGENT_NOTE_SCHEMA = `---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the StructuredOutput tool exactly once — the tool's input schema defines the required shape. Do your work, then call StructuredOutput; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call StructuredOutput again with a corrected shape.`;

/** Worktree isolation note (`isolation: 'worktree'`), appended to the agent prompt. */
export function worktreeNote(worktreePath: string, cwd: string): string {
	return `---
You are running in an isolated git worktree at \`${worktreePath}\` (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (\`${cwd}\`) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`;
}

/** Resume hint (`Pqt`) — pause/kill recovery one-liner. */
export function resumeHint(scriptPath: string, runId: string, args?: unknown): string {
	const argsJson = args === undefined ? "" : `, args: ${JSON.stringify(args)}`;
	return `Resume the paused workflow by calling: workflow({scriptPath: '${scriptPath}', resumeFromRunId: '${runId}'${argsJson}}) — completed agents return cached results.`;
}

/** Stall log line. */
export function stallLog(label: string, seconds: number, attempt: number, max: number): string {
	return `[stall] agent "${label}" stalled (no progress) after ${seconds}s — retrying (${attempt}/${max})`;
}

/** Throttle log line. */
export function throttleLog(label: string, tokens: number, seconds: number): string {
	return `[${label}] throttled response (no stop_reason, ${tokens} output tokens in ${seconds}s) — sleeping 45s before retry`;
}

/** Budget-exceeded error message (§6). */
export function budgetExceededError(spent: number, total: number): string {
	return `Workflow token budget exceeded (${spent} / ${total} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`;
}

/** Agent-cap error message (§6). */
export const agentCapError =
	"Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.";

/**
 * Saved-workflow command text (§7). In V1 `$ARGUMENTS` was expanded by
 * opencode's template machinery; in V2 the plugin's command executor receives
 * the raw argument text and expands it itself via `argsText`.
 */
export function workflowCommandTemplate(
	wf: {
		name: string;
		description: string;
		whenToUse?: string;
		phases?: { title: string; detail?: string }[];
	},
	argsText?: string,
): string {
	const lines = [`Run the \`${wf.name}\` workflow.`, wf.description];
	if (wf.whenToUse) lines.push(wf.whenToUse);
	if (wf.phases?.length) {
		lines.push("Phases:");
		for (const p of wf.phases) lines.push(`- ${p.title}${p.detail ? `: ${p.detail}` : ""}`);
	}
	const args = argsText?.trim();
	if (args) {
		lines.push(`Invoke the workflow tool with: { "name": "${wf.name}", "args": ${args} }`);
	} else {
		lines.push(
			`Invoke the workflow tool with: { "name": "${wf.name}" } — no arguments were provided, so omit the args field.`,
		);
	}
	return lines.join("\n");
}

/** `/workflows` command template (model-mediated via the workflow_status tool in v1). */
export const WORKFLOWS_COMMAND_TEMPLATE = `Show the user's workflows. Call the workflow_status tool (no arguments) and relay a concise summary: for each run — name, status, agents done/total, tokens, duration. If any run is still running, mention that the workflow_control tool can kill or pause it (give the runId). For incomplete runs, offer to resume with the workflow tool ({scriptPath, resumeFromRunId}) — completed agents return cached results.`;

/** workflow-subagent agent definition registered via the config hook. */
export const SUBAGENT_AGENT_NAME = "workflow-subagent";
export const SUBAGENT_AGENT_DESCRIPTION =
	"Internal subagent for workflow script orchestration. Its final text response is returned verbatim to the calling workflow script.";
