/**
 * Module-scope state shared across the plugin's hooks and tools:
 *  - live run registry (workflow_control targets)
 *  - worker-session → run/agent mapping (event-hook progress pings, orphan sweep)
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

export interface WorkerPing {
	runId: string;
	/** bump lastProgressAt — resets stall watchdogs */
	touch(): void;
	reportTool(toolName: string): void;
}

/** runId → run */
export const liveRuns = new Map<string, LiveRun>();

/** worker sessionID → ping handle */
export const workerPings = new Map<string, WorkerPing>();

export function registerRun(run: LiveRun): void {
	liveRuns.set(run.runId, run);
}

export function unregisterRun(runId: string): void {
	liveRuns.delete(runId);
}

export function registerWorker(sessionID: string, ping: WorkerPing): void {
	workerPings.set(sessionID, ping);
}

export function unregisterWorker(sessionID: string): void {
	workerPings.delete(sessionID);
}

/** opencode permission Rule shape (wildcard, last-match-wins). */
export interface PermissionRule {
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
}
