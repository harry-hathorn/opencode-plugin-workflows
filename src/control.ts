/**
 * Control bridge, server side. The TUI appends one JSON line per confirmed op to
 * <runDir>/control.jsonl (0600, see paths.ts); a drainer here re-reads those files
 * while runs are live and applies kill/pause — applyControlOp below is the one
 * implementation (the workflow_control tool and status.ts delegate to it).
 *
 * Ops are idempotent: an op against a settled (or unknown) run is a no-op, and
 * resume mints a fresh runId, so a stale line can never hijack a later run.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runsRoot, safeRunId } from "./journal";
import { controlPath } from "./paths";
import { resumeHint } from "./prompts";
import { liveRuns } from "./state";

export type WorkflowControlOp = "kill" | "pause";

export interface ControlOp {
	v: 1;
	/** random 16-hex id — dedupe key for at-least-once delivery */
	id: string;
	runId: string;
	op: WorkflowControlOp;
	ts: number;
	source: string;
}

const CONTROL_DRAIN_MS = 750;
const APPLIED_ID_CAP = 512;

export function newControlId(): string {
	return crypto.randomBytes(8).toString("hex");
}

export function encodeControlOp(input: Omit<ControlOp, "v">): string {
	return `${JSON.stringify({ ...input, v: 1 })}\n`;
}

/** Strict single-line validation: shape, types, enums, runId format. Extra keys are ignored. */
export function parseControlLine(line: string): ControlOp | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	if (rec.v !== 1) return null;
	if (typeof rec.id !== "string" || !/^[0-9a-f]{16}$/.test(rec.id)) return null;
	if (typeof rec.runId !== "string" || safeRunId(rec.runId) === null) return null;
	if (rec.op !== "kill" && rec.op !== "pause") return null;
	if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
	if (typeof rec.source !== "string" || !rec.source) return null;
	return { v: 1, id: rec.id, runId: rec.runId, op: rec.op, ts: rec.ts, source: rec.source };
}

export interface ControlApplyResult {
	output: string;
	ok: boolean;
}

/**
 * Shared semantics for the workflow_control tool and the TUI bridge: one
 * implementation, two callers (status.workflowControlOutput delegates here).
 */
export function applyControlOp(op: Pick<ControlOp, "runId" | "op">): ControlApplyResult {
	const { runId } = op;
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
	run.abort(op.op === "pause" ? "user-pause" : "user-kill");
	if (op.op === "pause") {
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
		const snap = JSON.parse(fs.readFileSync(path.join(runsRoot(), runId, "snapshot.json"), "utf8")) as {
			scriptPath?: string;
			args?: unknown;
		};
		if (snap.scriptPath) return resumeHint(snap.scriptPath, runId, snap.args);
	} catch {
		// snapshot not written yet (still running) — generic hint
	}
	return `Resume with: workflow({scriptPath: <script path>, resumeFromRunId: '${runId}'}) — completed agents return cached results.`;
}

// ---------------------------------------------------------------------------
// Drainer
// ---------------------------------------------------------------------------

interface FileState {
	offset: number;
	tail: string;
}

export interface ControlDrainer {
	/** one drain pass — visible for tests */
	poll(): void;
	stop(): void;
}

/**
 * Poll every live run's control file. Reading is incremental (byte offsets,
 * torn tails buffered until a newline lands) and every op id is remembered so a
 * replayed or duplicated line applies exactly once.
 */
export function startControlDrainer(intervalMs = CONTROL_DRAIN_MS): ControlDrainer {
	const offsets = new Map<string, FileState>();
	const applied = new Map<string, true>();

	const drainFile = (runId: string) => {
		const file = controlPath(runId);
		let size: number;
		try {
			size = fs.statSync(file).size;
		} catch {
			return; // no control file for this run — normal
		}
		const state = offsets.get(file) ?? { offset: 0, tail: "" };
		if (size < state.offset) {
			// truncated/rotated — start over
			state.offset = 0;
			state.tail = "";
		}
		if (size === state.offset) {
			offsets.set(file, state);
			return;
		}
		let chunk: string;
		try {
			const handle = fs.openSync(file, "r");
			try {
				const buffer = Buffer.alloc(size - state.offset);
				fs.readSync(handle, buffer, 0, buffer.length, state.offset);
				chunk = buffer.toString("utf8");
			} finally {
				fs.closeSync(handle);
			}
		} catch {
			return; // transient read error — retry next tick
		}
		state.offset = size;
		const lines = (state.tail + chunk).split("\n");
		state.tail = lines.pop() ?? "";
		offsets.set(file, state);
		for (const line of lines) {
			const op = parseControlLine(line);
			if (!op || applied.has(op.id)) continue;
			applied.set(op.id, true);
			if (applied.size > APPLIED_ID_CAP) {
				const oldest = applied.keys().next().value;
				if (oldest !== undefined) applied.delete(oldest);
			}
			applyControlOp(op);
		}
	};

	const poll = () => {
		if (liveRuns.size === 0) return;
		for (const runId of liveRuns.keys()) {
			const safe = safeRunId(runId);
			if (!safe) continue; // registry keys are server-minted; guard anyway
			drainFile(safe);
		}
	};

	const timer = setInterval(poll, intervalMs);
	timer.unref?.();
	return {
		poll,
		stop() {
			clearInterval(timer);
		},
	};
}
