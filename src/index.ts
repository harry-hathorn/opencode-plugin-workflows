/**
 * opencode-plugin-workflows — deterministic multi-agent workflow
 * orchestration for opencode, as a shareable plugin.
 *
 * The entry module exports ONLY a default {id, server}: file-path plugins MUST
 * carry `id` on the new-style loader (plugin/shared.ts), and the legacy
 * fallback path accepts the same shape because a default function/object
 * export is all it looks at. No named exports.
 *
 * Plugin options (second arg, set in config as
 * ["file://…/opencode-plugin-workflows", {budgetTotal: 500000}]):
 *   - budgetTotal?: number — hard output-token ceiling per workflow run
 *     (surfaced to scripts as budget.total; null = uncapped).
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import type { OpencodeClient } from "./agent";
import { registerCommands } from "./commands";
import { workflowControlOutput, workflowStatusOutput } from "./status";
import { createWorkflowTools } from "./tool";

const plugin: Plugin = async (input: PluginInput, options) => {
	const budgetTotal =
		options && typeof (options as { budgetTotal?: unknown }).budgetTotal === "number"
			? (options as { budgetTotal: number }).budgetTotal
			: null;

	const { workflowTool } = createWorkflowTools({
		// generated SDK client → our structural subset (session.create/prompt/abort/get)
		client: input.client as unknown as OpencodeClient,
		directory: input.directory,
		worktree: input.worktree,
		budgetTotal,
	});

	return {
		tool: {
			workflow: workflowTool,
			workflow_status: {
				description:
					"List running and recently completed workflows with live progress (agents done/total, tokens, duration, errors). Use this before workflow_control to get a runId, and after a pause/kill to confirm state.",
				args: {} satisfies z.ZodRawShape,
				async execute() {
					return { title: "workflow status", output: workflowStatusOutput() };
				},
			},
			workflow_control: {
				description:
					"Kill or pause a running workflow by runId. op='pause' aborts in-flight agents but preserves completed agent results for resume; op='kill' stops the run outright. Both remain resumable via workflow({scriptPath, resumeFromRunId}). Get runIds from workflow_status.",
				args: {
					runId: z.string().describe("Run id from workflow_status (wf_…)"),
					op: z
						.enum(["kill", "pause"])
						.describe("'pause' keeps completed results for resume; 'kill' stops the run"),
				} satisfies z.ZodRawShape,
				async execute(input: { runId: string; op: "kill" | "pause" }) {
					const { output } = workflowControlOutput(input.runId, input.op);
					return { title: `workflow ${input.op}: ${input.runId}`, output };
				},
			},
		},
		config: async (config) => {
			await registerCommands(config, { directory: input.directory, worktree: input.worktree });
		},
	};
};

export default {
	id: "opencode-plugin-workflows",
	server: plugin,
};
