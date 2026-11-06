import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyControlOp,
	type ControlOp,
	encodeControlOp,
	newControlId,
	parseControlLine,
	startControlDrainer,
} from "../src/control";
import { controlPath } from "../src/paths";
import type { WorkflowProgress } from "../src/runner";
import { type LiveRun, liveRuns, registerRun } from "../src/state";

let tmp: string;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-control-"));
	process.env.XDG_DATA_HOME = tmp; // runsRoot() → tmp/opencode/workflows
});

const RUN_ID = "wf_abc123def45";

function fakeRun(runId: string, over: Partial<LiveRun> = {}): { run: LiveRun; aborts: string[] } {
	const aborts: string[] = [];
	const empty: WorkflowProgress = { rows: [], agentCount: 0, totalTokens: 0, totalToolCalls: 0 };
	const run: LiveRun = {
		runId,
		name: "review",
		startedAt: 1,
		parentSessionID: "s1",
		abort: (reason) => {
			aborts.push(reason);
		},
		getProgress: () => empty,
		status: "running",
		...over,
	};
	return { run, aborts };
}

beforeEach(() => {
	liveRuns.clear();
	// each drainer starts from offset 0 — give every test a clean control file
	fs.rmSync(path.join(tmp, "opencode", "workflows", RUN_ID), { recursive: true, force: true });
});

function writeLine(runId: string, line: string): void {
	const file = controlPath(runId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

describe("control codec", () => {
	test("round-trips a valid op", () => {
		const op: ControlOp = {
			v: 1,
			id: newControlId(),
			runId: RUN_ID,
			op: "pause",
			ts: Date.now(),
			source: "opencode-tui",
		};
		expect(parseControlLine(encodeControlOp(op))).toEqual(op);
		expect(op.id).toMatch(/^[0-9a-f]{16}$/);
	});

	test("rejects malformed lines", () => {
		const base = { v: 1, id: newControlId(), runId: RUN_ID, op: "kill", ts: 1, source: "opencode-tui" };
		expect(parseControlLine("")).toBeNull();
		expect(parseControlLine("not json")).toBeNull();
		expect(parseControlLine("null")).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, v: 2 }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, id: "tooshort" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, id: "zzzzzzzzzzzzzzzz" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, runId: "../etc" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, runId: "not-a-run" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, op: "resume" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, ts: "now" }))).toBeNull();
		expect(parseControlLine(JSON.stringify({ ...base, source: "" }))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// apply semantics
// ---------------------------------------------------------------------------

describe("applyControlOp", () => {
	test("kill aborts a running run with user-kill", () => {
		const { run, aborts } = fakeRun(RUN_ID);
		registerRun(run);
		const result = applyControlOp({ runId: RUN_ID, op: "kill" });
		expect(result.ok).toBe(true);
		expect(aborts).toEqual(["user-kill"]);
	});

	test("pause aborts with user-pause", () => {
		const { run, aborts } = fakeRun(RUN_ID);
		registerRun(run);
		const result = applyControlOp({ runId: RUN_ID, op: "pause" });
		expect(result.ok).toBe(true);
		expect(aborts).toEqual(["user-pause"]);
	});

	test("unknown runId is tolerated and reported", () => {
		const result = applyControlOp({ runId: "wf_zzzzzzzzzzz9", op: "kill" });
		expect(result.ok).toBe(false);
		expect(result.output).toContain("No live workflow");
	});

	test("settled run: no abort, not ok", () => {
		const { run, aborts } = fakeRun(RUN_ID, { status: "completed" });
		registerRun(run);
		const result = applyControlOp({ runId: RUN_ID, op: "kill" });
		expect(result.ok).toBe(false);
		expect(aborts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// drainer
// ---------------------------------------------------------------------------

describe("control drainer", () => {
	test("applies ops in order, tracks offsets, stays idempotent", () => {
		const { run, aborts } = fakeRun(RUN_ID);
		registerRun(run);
		const drainer = startControlDrainer(60_000);

		const kill: ControlOp = { v: 1, id: newControlId(), runId: RUN_ID, op: "kill", ts: 1, source: "t" };
		const pause: ControlOp = { v: 1, id: newControlId(), runId: RUN_ID, op: "pause", ts: 2, source: "t" };
		writeLine(RUN_ID, encodeControlOp(kill));
		drainer.poll();
		expect(aborts).toEqual(["user-kill"]);

		writeLine(RUN_ID, encodeControlOp(pause));
		drainer.poll();
		expect(aborts).toEqual(["user-kill", "user-pause"]);

		drainer.poll(); // nothing new — offsets hold
		expect(aborts).toEqual(["user-kill", "user-pause"]);

		// shrink the file below the tracked offset (truncation/rotation): the
		// drainer resets and re-reads, but the applied-id set dedupes the ops
		fs.writeFileSync(controlPath(RUN_ID), encodeControlOp(kill));
		drainer.poll();
		expect(aborts).toEqual(["user-kill", "user-pause"]);
		drainer.stop();
	});

	test("buffers torn tails until the newline lands", () => {
		const { run, aborts } = fakeRun(RUN_ID);
		registerRun(run);
		const drainer = startControlDrainer(60_000);
		const op: ControlOp = { v: 1, id: newControlId(), runId: RUN_ID, op: "pause", ts: 3, source: "t" };
		const line = encodeControlOp(op).trimEnd();
		const file = controlPath(RUN_ID);
		fs.mkdirSync(path.dirname(file), { recursive: true });

		fs.appendFileSync(file, line.slice(0, 10)); // torn write — no newline yet
		drainer.poll();
		expect(aborts).toHaveLength(0);

		fs.appendFileSync(file, `${line.slice(10)}\n`);
		drainer.poll();
		expect(aborts).toEqual(["user-pause"]);
		drainer.stop();
	});

	test("skips garbage lines without losing the rest", () => {
		const { run, aborts } = fakeRun(RUN_ID);
		registerRun(run);
		const drainer = startControlDrainer(60_000);
		const op: ControlOp = { v: 1, id: newControlId(), runId: RUN_ID, op: "kill", ts: 4, source: "t" };
		writeLine(RUN_ID, "garbage line\n");
		writeLine(RUN_ID, encodeControlOp(op));
		drainer.poll();
		expect(aborts).toEqual(["user-kill"]);
		drainer.stop();
	});

	test("unknown runId in the file is tolerated", () => {
		const { run } = fakeRun(RUN_ID);
		registerRun(run);
		const drainer = startControlDrainer(60_000);
		const op: ControlOp = { v: 1, id: newControlId(), runId: "wf_unknown12345", op: "kill", ts: 5, source: "t" };
		writeLine("wf_unknown12345", encodeControlOp(op));
		expect(() => drainer.poll()).not.toThrow();
		drainer.stop();
	});

	test("no live runs: poll is a no-op even with files present", () => {
		const op: ControlOp = { v: 1, id: newControlId(), runId: RUN_ID, op: "kill", ts: 6, source: "t" };
		writeLine(RUN_ID, encodeControlOp(op));
		const drainer = startControlDrainer(60_000);
		expect(() => drainer.poll()).not.toThrow();
		drainer.stop();
	});
});
