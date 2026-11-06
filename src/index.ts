/**
 * opencode-plugin-workflows — deterministic multi-agent workflow
 * orchestration for opencode, as a shareable plugin. OpenCode V2 plugin API.
 *
 * The entry module default-exports a Plugin.define({id, setup}) definition
 * from @opencode/plugin. Registration happens through the context domains:
 *  - ctx.tool.transform     → the workflow / workflow_status / workflow_control tools
 *  - ctx.command.transform  → one slash command per saved workflow + /workflows
 *
 * Plugin options (set in config as
 * {"package": "file://…/opencode-plugin-workflows", "options": {budgetTotal: 500000}}):
 *   - budgetTotal?: number — hard output-token ceiling per workflow run
 *     (surfaced to scripts as budget.total; null = uncapped).
 */
import { Plugin } from "@opencode/plugin";
import type { OpencodeClient } from "./agent";
import { registerCommands } from "./commands";
import { applyControlOp, startControlDrainer } from "./control";
import { workflowStatusOutput } from "./status";
import { createWorkflowTools, type WorkflowToolContext } from "./tool";

// One drainer per server process — plugin init can run more than once (reload,
// multiple clients), and poll() early-returns while no runs are live.
let drainerStarted = false;

export default Plugin.define({
	id: "opencode-plugin-workflows",
	async setup(ctx) {
		if (!drainerStarted) {
			drainerStarted = true;
			startControlDrainer();
		}

		const budgetTotal =
			ctx.options && typeof (ctx.options as { budgetTotal?: unknown }).budgetTotal === "number"
				? (ctx.options as { budgetTotal: number }).budgetTotal
				: null;

		const { workflowTool } = createWorkflowTools({
			// the plugin context IS the client (domain methods) — our structural
			// subset (session.create/prompt/wait/interrupt/get/context) matches
			client: ctx as unknown as OpencodeClient,
			directory: ctx.location.directory,
			worktree: ctx.location.directory,
			budgetTotal,
			assertLaunch: async (toolCtx: WorkflowToolContext, dialog) => {
				await ctx.permission.assert({
					sessionID: toolCtx.sessionID,
					agent: toolCtx.agent,
					source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
					action: "workflow",
					resources: [dialog.resource],
					save: ["*"],
					metadata: {
						title: dialog.title,
						description: dialog.description,
						script: dialog.script,
						args: dialog.args,
						resumeFromRunId: dialog.resumeFromRunId,
					},
				});
			},
		});

		await ctx.tool.transform((editor) => {
			editor.add(workflowTool);
			editor.add({
				name: "workflow_status",
				description:
					"List running and recently completed workflows with live progress (agents done/total, tokens, duration, errors). Use this before workflow_control to get a runId, and after a pause/kill to confirm state.",
				input: { type: "object", properties: {}, additionalProperties: false },
				async execute() {
					return { content: workflowStatusOutput() };
				},
			});
			editor.add({
				name: "workflow_control",
				description:
					"Kill or pause a running workflow by runId. op='pause' aborts in-flight agents but preserves completed agent results for resume; op='kill' stops the run outright. Both remain resumable via workflow({scriptPath, resumeFromRunId}). Get runIds from workflow_status.",
				input: {
					type: "object",
					properties: {
						runId: { type: "string", description: "Run id from workflow_status (wf_…)" },
						op: {
							type: "string",
							enum: ["kill", "pause"],
							description: "'pause' keeps completed results for resume; 'kill' stops the run",
						},
					},
					required: ["runId", "op"],
					additionalProperties: false,
				},
				async execute(rawInput: unknown) {
					const input = (rawInput ?? {}) as { runId: string; op: "kill" | "pause" };
					const { output } = applyControlOp(input);
					return { content: output };
				},
			});
		});

		await registerCommands(ctx);
	},
});
