/**
 * Module-scope state shared across the plugin's hooks and tools:
 * the live run registry (workflow_control + TUI control-bridge targets).
 */
import type { WorkflowProgress } from "./runner";

export interface LiveRun {
	runId: string;
	name: string;
	startedAt: number;
	parentSessionID: string;
	abort(reason: string): void;
	getProgress(): WorkflowProgress;
	status: "running" | "completed" | "failed" | "killed" | "paused";
}

/** runId → run */
export const liveRuns = new Map<string, LiveRun>();

export function registerRun(run: LiveRun): void {
	liveRuns.set(run.runId, run);
}

export function unregisterRun(runId: string): void {
	liveRuns.delete(runId);
}

/**
 * opencode V2 permission rule shape ({action, resource, effect};
 * last-match-wins). Mirrors `PermissionRuleset` on SessionInfo.
 */
export interface PermissionRule {
	action: string;
	resource: string;
	effect: "allow" | "deny" | "ask";
}
