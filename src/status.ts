/**
 * workflow_status / workflow_control — the v1 /workflows surface, model-mediated:
 * the tools read the live-run registry + settled snapshots from
 * ~/.local/share/opencode/workflows/<runId>/snapshot.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runsRoot } from "./journal";
import { resumeHint } from "./prompts";
import { liveRuns } from "./state";

export interface RunSnapshot {
	runId: string;
	name: string;
	description?: string;
	status: "completed" | "failed" | "killed" | "paused";
	parentSessionID?: string;
	startedAt: number;
	durationMs: number;
	scriptPath?: string;
	agentCount: number;
	totalTokens: number;
	totalToolCalls: number;
	error?: string;
	args?: unknown;
}

export function snapshotPath(runId: string): string {
	return path.join(runsRoot(), runId, "snapshot.json");
}

export function writeSnapshot(snapshot: RunSnapshot & Record<string, unknown>): void {
	try {
		fs.mkdirSync(path.dirname(snapshotPath(snapshot.runId)), { recursive: true });
		fs.writeFileSync(snapshotPath(snapshot.runId), JSON.stringify(snapshot));
	} catch (err) {
		console.warn("[opencode-plugin-workflows] failed to write snapshot:", err);
	}
}

function listSnapshots(limit = 50): RunSnapshot[] {
	const root = runsRoot();
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const snapshots: RunSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("wf_")) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(root, entry, "snapshot.json"), "utf8")) as RunSnapshot;
			if (raw?.runId) snapshots.push(raw);
		} catch {
			// incomplete/corrupt snapshot — skip
		}
	}
	snapshots.sort((a, b) => b.startedAt - a.startedAt);
	return snapshots.slice(0, limit);
}

function fmtRun(r: {
	runId: string;
	name: string;
	status: string;
	agentCount?: number;
	totalTokens?: number;
	durationMs?: number;
	startedAt?: number;
	error?: string;
}): string {
	const parts = [
		`${r.name} [${r.runId}]`,
		r.status,
		r.agentCount !== undefined ? `${r.agentCount} agents` : undefined,
		r.totalTokens !== undefined ? `${r.totalTokens} tokens` : undefined,
		r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : undefined,
	].filter(Boolean);
	const line = parts.join(" · ");
	return r.error ? `${line}\n    error: ${r.error}` : line;
}

/** workflow_status execute() body → text for the model to relay. */
export function workflowStatusOutput(): string {
	const lines: string[] = [];
	const live = [...liveRuns.values()].sort((a, b) => a.startedAt - b.startedAt);
	if (live.length) {
		lines.push("Running workflows:");
		for (const run of live) {
			const p = run.getProgress();
			lines.push(
				`  ${fmtRun({
					runId: run.runId,
					name: run.name,
					status: run.status,
					agentCount: p.agentCount,
					totalTokens: p.totalTokens,
					durationMs: Date.now() - run.startedAt,
				})} (agents done: ${p.rows.filter((r) => r.type === "workflow_agent" && r.state === "done").length}/${p.agentCount})`,
			);
		}
	}
	const snapshots = listSnapshots();
	const liveIds = new Set(live.map((r) => r.runId));
	const settled = snapshots.filter((s) => !liveIds.has(s.runId));
	if (settled.length) {
		lines.push("Recent workflows:");
		for (const s of settled) lines.push(`  ${fmtRun(s)}`);
	}
	if (!lines.length) return "No workflows have been run yet.";
	const out = lines.join("\n");
	return `${out}\n\nUse workflow_control with a runId to kill/pause a running workflow. Paused or killed runs resume via the workflow tool: workflow({scriptPath, resumeFromRunId}) — completed agents return cached results.`;
}

export type WorkflowControlOp = "kill" | "pause";

export function workflowControlOutput(runId: string, op: WorkflowControlOp): { output: string; ok: boolean } {
	const run = liveRuns.get(runId);
	if (!run) {
		return {
			output: `No live workflow with runId ${runId}. Call workflow_status to list runs.`,
			ok: false,
		};
	}
	if (run.status !== "running") {
		return { output: `Workflow ${runId} already ${run.status}.`, ok: false };
	}
	run.abort(op === "pause" ? "user-pause" : "user-kill");
	if (op === "pause") {
		return {
			output: `Workflow ${run.name} [${runId}] paused. In-flight agents were aborted; completed agent results are preserved in the journal. ${resumeHintFor(runId)}`,
			ok: true,
		};
	}
	return { output: `Workflow ${run.name} [${runId}] killed. ${resumeHintFor(runId)}`, ok: true };
}

function resumeHintFor(runId: string): string {
	// snapshot knows the persisted script path
	try {
		const snap = JSON.parse(fs.readFileSync(snapshotPath(runId), "utf8")) as RunSnapshot & { scriptPath?: string };
		if (snap.scriptPath) return resumeHint(snap.scriptPath, runId, snap.args);
	} catch {
		// snapshot not written yet (still running) — generic hint
	}
	return `Resume with: workflow({scriptPath: <script path>, resumeFromRunId: '${runId}'}) — completed agents return cached results.`;
}
