/**
 * Config-hook registration. Everything must be registered inside the hook —
 * Command.state memoizes lazily on first GET /command (after hooks run) and is
 * never invalidated.
 *
 *  - config.agent["workflow-subagent"]: the worker subagent. An agent's `prompt`
 *    REPLACES the default system prompt (the one true replace lever —
 *    PromptInput.system only ever appends), which is how the worker system
 *    prompt takes effect. permission edit:allow keeps file edits friction-free.
 *  - config.command[name]: one slash command per discovered saved workflow.
 *  - config.command["workflows"]: the /workflows browser (model-mediated via
 *    workflow_status in v1).
 */
import type { Config } from "@opencode-ai/plugin";
import {
	SUBAGENT_AGENT_DESCRIPTION,
	SUBAGENT_AGENT_NAME,
	SUBAGENT_PROMPT_TEXT,
	WORKFLOWS_COMMAND_TEMPLATE,
	workflowCommandTemplate,
} from "./prompts";
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

export async function registerCommands(config: Config, ctx: { directory: string; worktree: string }): Promise<void> {
	// --- workflow-subagent agent ---
	config.agent ??= {};
	if (!config.agent[SUBAGENT_AGENT_NAME]) {
		config.agent[SUBAGENT_AGENT_NAME] = {
			description: SUBAGENT_AGENT_DESCRIPTION,
			mode: "subagent",
			prompt: SUBAGENT_PROMPT_TEXT,
			// workflow children default to acceptEdits: file edits flow,
			// everything else follows the user's global permission config.
			permission: { edit: "allow" },
		};
	}

	// --- per-workflow commands + /workflows ---
	config.command ??= {};
	const workflows = discoverWorkflows(ctx.directory, ctx.worktree);
	for (const wf of workflows) {
		if (config.command[wf.name] || RESERVED_COMMANDS.has(wf.name)) continue;
		config.command[wf.name] = {
			description: wf.description,
			template: workflowCommandTemplate(wf),
		};
	}
	if (!config.command.workflows) {
		config.command.workflows = {
			description: "Browse running and completed workflows",
			template: WORKFLOWS_COMMAND_TEMPLATE,
		};
	}
}
