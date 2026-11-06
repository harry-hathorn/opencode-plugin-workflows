/**
 * Command registration, OpenCode V2 style.
 *
 * Everything registers through ctx.command.transform inside setup. Discovered
 * saved workflows are read once at setup; the workflow directories are not
 * watched (same freshness model as the V1 config hook — a config change or
 * /reload re-runs setup).
 *
 * NOTE (2.2.5): plugins cannot register agents (AgentEditor has no add), so
 * the V1 workflow-subagent agent is gone. The worker contract rides on each
 * worker prompt instead — see WORKER_PREAMBLE in prompts.ts and agent.ts.
 *
 *  - /<workflow-name>: one command per discovered saved workflow
 *  - /workflows: the browser (model-mediated via workflow_status)
 */
import type { Plugin } from "@opencode/plugin";
import { WORKFLOWS_COMMAND_TEMPLATE, workflowCommandTemplate } from "./prompts";
import { discoverWorkflows } from "./registry";

/** Built-in slash names we never shadow. */
const RESERVED_COMMANDS = new Set([
	"init",
	"review",
	"help",
	"undo",
	"redo",
	"share",
	"new",
	"exit",
	"clear",
	"compact",
	"resume",
	"sessions",
	"models",
	"themes",
	"export",
	"import",
	"workflows", // ours, registered below
]);

export async function registerCommands(ctx: Plugin.Context): Promise<void> {
	const directory = ctx.location.directory;
	const workflows = discoverWorkflows(directory, directory);

	await ctx.command.transform((editor) => {
		for (const wf of workflows) {
			if (RESERVED_COMMANDS.has(wf.name)) continue;
			editor.add({
				name: wf.name,
				description: wf.description ?? `Run the ${wf.name} workflow`,
				async execute({ sessionID, prompt, delivery }) {
					const text = workflowCommandTemplate(wf, prompt.text);
					await ctx.session.prompt({
						sessionID,
						text,
						files: prompt.files,
						delivery: delivery ?? "steer",
					});
				},
			});
		}

		editor.add({
			name: "workflows",
			description: "Browse running and completed workflows",
			async execute({ sessionID, prompt, delivery }) {
				const text = prompt.text.trim()
					? `${WORKFLOWS_COMMAND_TEMPLATE}\n\n${prompt.text.trim()}`
					: WORKFLOWS_COMMAND_TEMPLATE;
				await ctx.session.prompt({
					sessionID,
					text,
					files: prompt.files,
					delivery: delivery ?? "steer",
				});
			},
		});
	});
}
