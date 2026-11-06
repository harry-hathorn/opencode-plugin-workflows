import { describe, expect, test } from "bun:test";
import {
	type AgentRow,
	agentGlyph,
	buildInlineView,
	buildRuns,
	type DashboardFilter,
	extractPartEvidence,
	flattenRun,
	fmtDuration,
	fmtTokens,
	isNestedTitle,
	type JournalEvidence,
	type LogRow,
	type PartEvidence,
	type PhaseRow,
	type ProgressRow,
	parseJournalEvidence,
	parseProgress,
	parseScriptName,
	parseSnapshot,
	type RunSnapshotLite,
	runGlyph,
	STALE_MS,
	supersedeRows,
	titleWorkflowName,
	type WorkflowProgress,
} from "../src/tui/data";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function phaseRow(index: number, title: string, over: Partial<PhaseRow> = {}): PhaseRow {
	return { type: "workflow_phase", index, title, kind: "main", ...over };
}

function agentRow(index: number, over: Partial<AgentRow> = {}): AgentRow {
	return { type: "workflow_agent", index, label: `agent-${index}`, state: "done", ...over };
}

function logRow(message: string): LogRow {
	return { type: "workflow_log", message };
}

function progress(rows: ProgressRow[], over: Partial<WorkflowProgress> = {}): WorkflowProgress {
	return {
		rows,
		agentCount: rows.filter((r) => r.type === "workflow_agent").length,
		totalTokens: 0,
		totalToolCalls: 0,
		...over,
	};
}

function partEvidence(runId: string, rows: ProgressRow[], over: Partial<PartEvidence> = {}): PartEvidence {
	return {
		runId,
		sessionID: "s-parent",
		messageID: "m1",
		partID: "p1",
		updatedAt: 10_000,
		progress: progress(rows),
		...over,
	};
}

function snapshot(runId: string, over: Partial<RunSnapshotLite> = {}): RunSnapshotLite {
	return {
		runId,
		name: "review",
		status: "completed",
		startedAt: 100,
		durationMs: 900,
		agentCount: 2,
		totalTokens: 10,
		totalToolCalls: 0,
		...over,
	};
}

// ---------------------------------------------------------------------------
// defensive parsing
// ---------------------------------------------------------------------------

describe("parseProgress", () => {
	test("keeps valid rows and coerces counters", () => {
		const parsed = parseProgress({
			rows: [phaseRow(0, "scan"), agentRow(0), logRow("hi")],
			agentCount: "x",
			totalTokens: "y",
			toolCalls: true,
		});
		expect(parsed?.rows).toHaveLength(3);
		expect(parsed?.agentCount).toBe(1);
		expect(parsed?.totalTokens).toBe(0);
	});

	test("drops malformed rows", () => {
		const parsed = parseProgress({
			rows: [
				{ type: "workflow_agent", index: 0, label: 5, state: "done" }, // bad label
				{ type: "workflow_agent", index: 1, label: "ok", state: "weird" }, // bad state
				{ type: "workflow_phase", index: "x", title: "t" }, // bad index
				agentRow(2),
			],
		});
		if (!parsed) throw new Error("expected parseProgress to accept the mixed rows");
		expect(parsed.rows).toHaveLength(1);
		expect((parsed.rows[0] as AgentRow).index).toBe(2);
	});

	test("rejects non-objects and missing rows", () => {
		expect(parseProgress(null)).toBeNull();
		expect(parseProgress("rows")).toBeNull();
		expect(parseProgress({ agentCount: 3 })).toBeNull();
	});
});

describe("parseSnapshot", () => {
	test("parses a full snapshot", () => {
		const parsed = parseSnapshot({
			runId: "wf_abc123def45",
			name: "review",
			status: "failed",
			startedAt: 5,
			durationMs: 7,
			agentCount: 1,
			totalTokens: 2,
			totalToolCalls: 3,
			error: "boom",
			rows: [agentRow(0)],
		});
		expect(parsed?.status).toBe("failed");
		expect(parsed?.rows).toHaveLength(1);
		expect(parsed?.error).toBe("boom");
	});

	test("rejects missing or wrong-typed essentials", () => {
		expect(parseSnapshot(null)).toBeNull();
		expect(parseSnapshot({ name: "x", status: "completed", startedAt: 1 })).toBeNull(); // no runId
		expect(parseSnapshot({ runId: "wf_a", name: "x", status: "running", startedAt: 1 })).toBeNull(); // live status
		expect(parseSnapshot({ runId: "wf_a", name: "x", status: "completed", startedAt: "soon" })).toBeNull();
	});
});

describe("extractPartEvidence", () => {
	const ctx = { sessionID: "s1", messageID: "m1", partID: "p1", updatedAt: 42 };

	test("extracts a workflow part", () => {
		const ev = extractPartEvidence({ runId: "wf_abc123def45", workflowProgress: progress([agentRow(0)]) }, ctx);
		expect(ev?.runId).toBe("wf_abc123def45");
		expect(ev?.progress.rows).toHaveLength(1);
	});

	test("rejects parts without the protocol", () => {
		expect(extractPartEvidence({ runId: "wf_abc123def45" }, ctx)).toBeNull(); // no progress
		expect(extractPartEvidence({ workflowProgress: progress([]) }, ctx)).toBeNull(); // no runId
		expect(extractPartEvidence({ runId: "not-wf", workflowProgress: progress([]) }, ctx)).toBeNull();
		expect(extractPartEvidence(undefined, ctx)).toBeNull();
	});

	test("carries nested metadata when present", () => {
		const ev = extractPartEvidence(
			{ runId: "wf_abc123def45", workflowProgress: progress([]), workflowName: "lint", nested: true },
			ctx,
		);
		expect(ev?.workflowName).toBe("lint");
		expect(ev?.nested).toBe(true);
	});
});

describe("title helpers", () => {
	test("captures the emitting workflow's name from either title shape", () => {
		expect(titleWorkflowName("workflow review [wf_abc123def45] — 1/2 agents")).toBe("review");
		expect(titleWorkflowName("workflow ▸ lint [wf_abc123def45]: 0/1 agents")).toBe("lint");
		expect(titleWorkflowName(undefined)).toBeUndefined();
		expect(titleWorkflowName("no brackets here")).toBeUndefined();
	});

	test("nested titles are recognizable", () => {
		expect(isNestedTitle("workflow ▸ lint [wf_x]: 0/1 agents")).toBe(true);
		expect(isNestedTitle("workflow review [wf_x] — 1/2")).toBe(false);
		expect(isNestedTitle(undefined)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// supersession
// ---------------------------------------------------------------------------

describe("supersedeRows", () => {
	test("highest attempt wins per agent index", () => {
		const out = supersedeRows([
			agentRow(0, { state: "error", attempt: 1, error: "first try failed" }),
			agentRow(0, { state: "done", attempt: 2 }),
		]);
		expect(out).toHaveLength(1);
		expect((out[0] as AgentRow).attempt).toBe(2);
		expect((out[0] as AgentRow).state).toBe("done");
	});

	test("same attempt: later position wins", () => {
		const out = supersedeRows([agentRow(0, { state: "progress" }), agentRow(0, { state: "done" })]);
		expect((out[0] as AgentRow).state).toBe("done");
	});

	test("phase keeps first position, latest content; agents group under phases", () => {
		const out = supersedeRows([
			phaseRow(0, "scan"),
			agentRow(1, { phaseIndex: 1, state: "done" }),
			phaseRow(1, "fix"),
			agentRow(0, { phaseIndex: 0, state: "done" }),
			phaseRow(0, "scan (edited)"),
			agentRow(2, { state: "done" }), // unphased
			logRow("narrator"),
		]);
		const phases = out.filter((r): r is PhaseRow => r.type === "workflow_phase");
		expect(phases.map((p) => p.index)).toEqual([0, 1]);
		expect(phases[0].title).toBe("scan (edited)");
		const agents = out.filter((r): r is AgentRow => r.type === "workflow_agent");
		expect(agents.map((a) => a.index)).toEqual([2, 0, 1]); // unphased, phase 0, phase 1
		expect(out[out.length - 1]).toEqual(logRow("narrator"));
	});
});

// ---------------------------------------------------------------------------
// run assembly
// ---------------------------------------------------------------------------

describe("buildRuns", () => {
	test("latest part per runId wins on duplicates", () => {
		const runs = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "progress" })], { updatedAt: 100 }),
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "done" })], { updatedAt: 200 }),
			],
			snapshots: [],
			now: 300,
		});
		expect(runs).toHaveLength(1);
		expect((runs[0].rows[0] as AgentRow).state).toBe("done");
	});

	test("live run: status running, not stale", () => {
		const runs = buildRuns({
			parts: [partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "progress" })], { updatedAt: 1000 })],
			snapshots: [],
			now: 1000 + STALE_MS - 1,
		});
		expect(runs[0].status).toBe("running");
		expect(runs[0].live).toBe(true);
		expect(runs[0].stale).toBe(false);
	});

	test("live run goes stale after STALE_MS without updates", () => {
		const runs = buildRuns({
			parts: [partEvidence("wf_aaaaaaaaaaa1", [agentRow(0)], { updatedAt: 1000 })],
			snapshots: [],
			now: 1000 + STALE_MS + 1,
		});
		expect(runs[0].stale).toBe(true);
	});

	test("settled part derives terminal status", () => {
		const runs = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0), agentRow(1)], {
					updatedAt: 2000,
					endedAt: 2000,
					partStatus: "completed",
				}),
			],
			snapshots: [],
			now: 3000,
		});
		expect(runs[0].status).toBe("completed");
		expect(runs[0].live).toBe(false);
		expect(runs[0].durationMs).toBeDefined();
	});

	test("settled part with an error row derives failed", () => {
		const runs = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "error", error: "kaput" })], {
					endedAt: 2000,
					partStatus: "completed",
				}),
			],
			snapshots: [],
			now: 3000,
		});
		expect(runs[0].status).toBe("failed");
		expect(runs[0].error).toBe("kaput");
	});

	test("snapshot wins the settle race against a lagging live part", () => {
		const runs = buildRuns({
			parts: [partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "progress" })], { updatedAt: 1000 })],
			snapshots: [snapshot("wf_aaaaaaaaaaa1", { status: "completed", startedAt: 100, durationMs: 2000 })],
			now: 3000,
		});
		expect(runs[0].status).toBe("completed");
		expect(runs[0].live).toBe(false);
	});

	test("updated live part beats an older snapshot", () => {
		const runs = buildRuns({
			parts: [partEvidence("wf_aaaaaaaaaaa1", [agentRow(0, { state: "progress" })], { updatedAt: 5000 })],
			snapshots: [snapshot("wf_aaaaaaaaaaa1", { startedAt: 100, durationMs: 200 })],
			now: 6000,
		});
		expect(runs[0].status).toBe("running");
		expect(runs[0].live).toBe(true);
	});

	test("settled part + snapshot: the snapshot's terminal status wins over derivation", () => {
		// a killed run settles its part with aborted agents in error state —
		// derivation alone would call this "failed"
		const runs = buildRuns({
			parts: [
				partEvidence(
					"wf_aaaaaaaaaaa1",
					[agentRow(0, { state: "done" }), agentRow(1, { state: "error", error: "aborted" })],
					{ endedAt: 900, updatedAt: 900 },
				),
			],
			snapshots: [snapshot("wf_aaaaaaaaaaa1", { status: "killed", durationMs: 800, error: "aborted (user-kill)" })],
			now: 1000,
		});
		expect(runs[0].status).toBe("killed");
		expect(runs[0].error).toBe("aborted (user-kill)");
		expect(runs[0].durationMs).toBe(800);
		expect(runs[0].live).toBe(false);
		// rows still come from the part (sessionIds for the jump targets)
		expect(runs[0].rows).toHaveLength(2);
	});

	test("snapshot-only run renders from the snapshot", () => {
		const runs = buildRuns({
			parts: [],
			snapshots: [snapshot("wf_aaaaaaaaaaa1", { status: "killed", rows: undefined, error: "user-kill" })],
			now: 1000,
		});
		expect(runs[0].status).toBe("killed");
		expect(runs[0].name).toBe("review");
		expect(runs[0].live).toBe(false);
	});

	test("nested evidence flags the run and surfaces the child workflow name", () => {
		const runs = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0)], {
					title: "workflow ▸ lint [wf_aaaaaaaaaaa1]: 0/1 agents",
					updatedAt: 2000,
				}),
			],
			snapshots: [],
			now: 3000,
		});
		expect(runs[0].nested).toBe(true);
		expect(runs[0].workflowName).toBe("lint");
		expect(runs[0].name).not.toBe("lint");
	});

	test("runs sort newest-evidence first", () => {
		const runs = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [agentRow(0)], { updatedAt: 100 }),
				partEvidence("wf_bbbbbbbbbbb2", [agentRow(0)], { updatedAt: 900 }),
			],
			snapshots: [],
			now: 1000,
		});
		expect(runs.map((r) => r.runId)).toEqual(["wf_bbbbbbbbbbb2", "wf_aaaaaaaaaaa1"]);
	});
});

// ---------------------------------------------------------------------------
// flattening + presentation
// ---------------------------------------------------------------------------

function flatRun(filter: DashboardFilter, showLogs = false) {
	const run = buildRuns({
		parts: [
			partEvidence("wf_aaaaaaaaaaa1", [
				phaseRow(0, "scan"),
				agentRow(0, { phaseIndex: 0, state: "done" }),
				agentRow(1, { phaseIndex: 0, state: "error", error: "x" }),
				phaseRow(1, "fix"),
				agentRow(2, { phaseIndex: 1, state: "progress" }),
				agentRow(3, { phaseIndex: 1, state: "start" }),
				logRow("noise"),
			]),
		],
		snapshots: [],
		now: 2000,
	})[0];
	return flattenRun(run, { filter, showLogs });
}

describe("flattenRun", () => {
	test("all: phases with counts then their agents, logs hidden by default", () => {
		const rows = flatRun("all");
		expect(rows.map((r) => r.kind)).toEqual(["phase", "agent", "agent", "phase", "agent", "agent"]);
		expect(rows[0]).toMatchObject({ kind: "phase", total: 2, visible: 2 });
		expect(rows.every((r) => r.kind !== "log")).toBe(true);
	});

	test("showLogs appends narrator lines", () => {
		const rows = flatRun("all", true);
		expect(rows[rows.length - 1]).toMatchObject({ kind: "log", message: "noise" });
	});

	test("running filter keeps only active agents and drops empty phases", () => {
		const rows = flatRun("running");
		expect(rows.map((r) => r.kind)).toEqual(["phase", "agent", "agent"]);
		expect((rows[1] as { agent: AgentRow }).agent.index).toBe(2);
		expect((rows[2] as { agent: AgentRow }).agent.index).toBe(3);
	});

	test("done filter includes cached and skipped agents", () => {
		const run = buildRuns({
			parts: [
				partEvidence("wf_aaaaaaaaaaa1", [
					agentRow(0, { state: "done" }),
					agentRow(1, { cached: true }),
					agentRow(2, { skipped: true }),
					agentRow(3, { state: "progress" }),
				]),
			],
			snapshots: [],
			now: 1000,
		})[0];
		const rows = flattenRun(run, { filter: "done" });
		expect(rows).toHaveLength(3);
	});

	test("error filter keeps the phase header plus error rows", () => {
		const rows = flatRun("error");
		expect(rows.map((r) => r.kind)).toEqual(["phase", "agent"]);
		expect((rows[1] as { agent: AgentRow }).agent.error).toBe("x");
	});
});

describe("glyphs + formatters", () => {
	test("agent glyph mapping", () => {
		expect(agentGlyph({ state: "done" })).toBe("✔");
		expect(agentGlyph({ state: "error" })).toBe("✗");
		expect(agentGlyph({ state: "progress" })).toBe("◐");
		expect(agentGlyph({ state: "start" })).toBe("○");
		expect(agentGlyph({ state: "done", cached: true })).toBe("↻");
		expect(agentGlyph({ state: "done", skipped: true })).toBe("◦");
	});

	test("run glyph mapping", () => {
		expect(runGlyph("running")).toBe("◐");
		expect(runGlyph("completed")).toBe("✔");
		expect(runGlyph("failed")).toBe("✗");
		expect(runGlyph("killed")).toBe("⊘");
		expect(runGlyph("paused")).toBe("⏸");
		expect(runGlyph("unknown")).toBe("·");
	});

	test("token formatting", () => {
		expect(fmtTokens(undefined)).toBe("");
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1200)).toBe("1.2k");
		expect(fmtTokens(18_000)).toBe("18k");
		expect(fmtTokens(2_400_000)).toBe("2.4M");
	});

	test("duration formatting", () => {
		expect(fmtDuration(undefined)).toBe("");
		expect(fmtDuration(1200)).toBe("1.2s");
		expect(fmtDuration(45_000)).toBe("45s");
		expect(fmtDuration(63_000)).toBe("1m03s");
		expect(fmtDuration(3_660_000)).toBe("1h01m");
	});
});

// ---------------------------------------------------------------------------
// journal evidence (S1b) — live runs discovered before any part exists
// ---------------------------------------------------------------------------

describe("journal evidence", () => {
	const JOURNAL = [
		'{"type":"launched","ts":100}',
		'{"type":"started","key":"k1","agentId":"a1","label":"one","phase":"scan","ts":110}',
		'{"type":"result","key":"k1","agentId":"a1","result":"ok-one","ts":150}',
		'{"type":"started","key":"k2","agentId":"a2","label":"two","phase":"scan","ts":160}',
		'{"type":"failed","key":"k2","agentId":"a2","error":"worker exploded","ts":200}',
		'{"type":"other"}',
		'{"type":"resu',
	].join("\n");

	test("parses rows into phases + agents, skipping unknown types and torn tails", () => {
		const ev = parseJournalEvidence(JOURNAL, "wf_journalaaaa1");
		expect(ev).not.toBeNull();
		expect(ev?.agentCount).toBe(2);
		expect(ev?.startedAt).toBe(100);
		expect(ev?.updatedAt).toBe(200);
		const agents = (ev?.rows ?? []).filter((r): r is AgentRow => r.type === "workflow_agent");
		expect(agents[0]).toMatchObject({
			agentId: "a1",
			state: "done",
			resultPreview: "ok-one",
			phaseTitle: "scan",
			phaseIndex: 0,
		});
		expect(agents[1]).toMatchObject({ agentId: "a2", state: "error", error: "worker exploded" });
		expect(ev?.rows.some((r) => r.type === "workflow_phase" && r.title === "scan")).toBe(true);
	});

	test("returns null for empty or unparseable journals", () => {
		expect(parseJournalEvidence("", "wf_x")).toBeNull();
		expect(parseJournalEvidence("not json at all\n", "wf_x")).toBeNull();
	});

	test("a resumed run's fresh launched row wins startedAt", () => {
		const resumed = [
			'{"type":"launched","ts":100}',
			'{"type":"result","key":"k1","agentId":"a1","result":"cached","ts":150}',
			'{"type":"launched","ts":9000}',
		].join("\n");
		const ev = parseJournalEvidence(resumed, "wf_resumeaaaa1");
		expect(ev?.startedAt).toBe(9000);
	});

	test("script name lifted from the meta literal", () => {
		expect(parseScriptName("export const meta = { name: 'review', description: 'x' }\nrest")).toBe("review");
		expect(parseScriptName("// no meta here")).toBeUndefined();
	});

	test("journal-only runIds surface as live runs with parent + agent session attribution", () => {
		const ev = parseJournalEvidence(JOURNAL, "wf_journalaaaa1") as JournalEvidence;
		const runs = buildRuns({
			parts: [],
			snapshots: [],
			journals: [ev],
			parents: new Map([["wf_journalaaaa1", "ses_parent"]]),
			agentSessions: new Map([["wf_journalaaaa1:a1", "ses_child1"]]),
			now: 300,
		});
		expect(runs).toHaveLength(1);
		const run = runs[0];
		expect(run.status).toBe("running");
		expect(run.live).toBe(true);
		expect(run.parentSessionID).toBe("ses_parent");
		expect(run.startedAt).toBe(100);
		expect(run.name).toBe("workflow"); // evidence carries no script name
		expect(run.stale).toBe(false);
		const a1 = run.rows.find((r): r is AgentRow => r.type === "workflow_agent" && r.agentId === "a1");
		expect(a1?.sessionId).toBe("ses_child1");
	});

	test("stale hint once the journal stops moving", () => {
		const ev = parseJournalEvidence(JOURNAL, "wf_journalaaaa1") as JournalEvidence;
		const runs = buildRuns({ parts: [], snapshots: [], journals: [ev], now: 200 + STALE_MS + 1 });
		expect(runs[0].stale).toBe(true);
	});

	test("a snapshot beats the journal (settle wins), and so does a part", () => {
		const ev = parseJournalEvidence(JOURNAL, "wf_journalaaaa1") as JournalEvidence;
		const settled = buildRuns({
			parts: [],
			snapshots: [snapshot("wf_journalaaaa1")],
			journals: [ev],
			now: 500,
		});
		expect(settled[0].status).toBe("completed");
		expect(settled[0].live).toBe(false);

		const withPart = buildRuns({
			parts: [partEvidence("wf_journalaaaa1", [agentRow(0, { state: "done" })], { endedAt: 900, updatedAt: 950 })],
			snapshots: [],
			journals: [ev],
			now: 1000,
		});
		expect(withPart[0].live).toBe(false);
		expect(withPart[0].rows).toHaveLength(1);
	});
});

describe("buildInlineView", () => {
	function runOf(rows: ProgressRow[], over: Partial<ReturnType<typeof buildRuns>[number]> = {}) {
		const runs = buildRuns({ parts: [partEvidence("wf_inlineaaaaa1", rows)], snapshots: [], now: 1000 });
		return { ...runs[0], ...over };
	}

	test("phases bucket their agents with done/total counts", () => {
		const view = buildInlineView(
			runOf([
				phaseRow(0, "review"),
				phaseRow(1, "verify"),
				agentRow(0, { phaseIndex: 0, state: "done" }),
				agentRow(1, { phaseIndex: 0, state: "progress" }),
				agentRow(2, { phaseIndex: 1, state: "start" }),
			]),
		);
		expect(view.phases.map((p) => p.title)).toEqual(["review", "verify"]);
		expect(view.phases[0].done).toBe(1);
		expect(view.phases[0].total).toBe(2);
		expect(view.phases[1].done).toBe(0);
		expect(view.phases[1].total).toBe(1);
		expect(view.done).toBe(1);
		expect(view.agentCount).toBe(3);
	});

	test("no phase rows → single synthetic run bucket", () => {
		const view = buildInlineView(runOf([agentRow(0, { state: "done" }), agentRow(1, { state: "progress" })]));
		expect(view.phases).toHaveLength(1);
		expect(view.phases[0].title).toBe("run");
		expect(view.phases[0].total).toBe(2);
		expect(view.phases[0].done).toBe(1);
	});

	test("unphased agents before declared phases lead under prep", () => {
		const view = buildInlineView(
			runOf([
				phaseRow(0, "main"),
				agentRow(0, { state: "done" }),
				agentRow(1, { phaseIndex: 0, state: "progress" }),
			]),
		);
		expect(view.phases.map((p) => p.title)).toEqual(["prep", "main"]);
		expect(view.phases[0].total).toBe(1);
		expect(view.phases[1].total).toBe(1);
	});

	test("cached and skipped agents count as done", () => {
		const view = buildInlineView(
			runOf([agentRow(0, { state: "start", cached: true }), agentRow(1, { state: "start", skipped: true })]),
		);
		expect(view.phases[0].done).toBe(2);
		expect(view.done).toBe(2);
	});

	test("carries run identity, status, and totals", () => {
		const view = buildInlineView(
			runOf([agentRow(0, { state: "progress" })], {
				name: "deploy",
				status: "running",
				stale: true,
				totalTokens: 1234,
			}),
		);
		expect(view.runId).toBe("wf_inlineaaaaa1");
		expect(view.name).toBe("deploy");
		expect(view.status).toBe("running");
		expect(view.stale).toBe(true);
		expect(view.totalTokens).toBe(1234);
	});
});
