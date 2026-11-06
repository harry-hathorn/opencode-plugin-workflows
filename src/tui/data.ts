/**
 * Pure derivations for the TUI: evidence → run views → dashboard rows.
 *
 * No imports at all (server, TUI, and tests all bundle this file), so the
 * protocol types below are deliberate structural mirrors of the server's
 * runner.ts rows — the two bundles must stay decoupled. Everything here is
 * synchronous and side-effect-free so bun can pin the merge/supersession/
 * flattening rules down in tests.
 */

// ---------------------------------------------------------------------------
// Protocol mirror (runner.ts)
// ---------------------------------------------------------------------------

export type AgentRowState = "start" | "progress" | "done" | "error";

export interface PhaseRow {
	type: "workflow_phase";
	index: number;
	title: string;
	kind: "main" | "child";
}

export interface AgentRow {
	type: "workflow_agent";
	index: number;
	label: string;
	phaseIndex?: number;
	phaseTitle?: string;
	agentId?: string;
	/** worker session id once created — the jump-to-session correlation */
	sessionId?: string;
	agentType?: string;
	model?: string;
	isolation?: "worktree";
	state: AgentRowState;
	queuedAt?: number;
	startedAt?: number;
	attempt?: number;
	lastAttemptReason?: string;
	cached?: boolean;
	skipped?: boolean;
	blocked?: boolean;
	error?: string;
	tokens?: number;
	toolCalls?: number;
	durationMs?: number;
	resultPreview?: string;
	promptPreview?: string;
}

export interface LogRow {
	type: "workflow_log";
	message: string;
}

export type ProgressRow = PhaseRow | AgentRow | LogRow;

export interface WorkflowProgress {
	rows: ProgressRow[];
	agentCount: number;
	totalTokens: number;
	totalToolCalls: number;
}

// ---------------------------------------------------------------------------
// Protocol mirror (status.ts RunSnapshot) — fields the TUI trusts off disk
// ---------------------------------------------------------------------------

export interface RunSnapshotLite {
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
	/** settled progress rows (server writes them on settle) */
	rows?: ProgressRow[];
	nested?: Array<{ name: string; status: string; rows: ProgressRow[] }>;
}

/** Snapshot settle time — the tiebreaker for live-part vs settled-snapshot races. */
export function snapshotSettledAt(snapshot: RunSnapshotLite): number {
	return snapshot.startedAt + snapshot.durationMs;
}

// ---------------------------------------------------------------------------
// Journal evidence (S1b) — the tool part only becomes visible at settle on
// 1.18.30, but journal.jsonl rows land synchronously during the run, so live
// runs are discovered by scanning run dirs that have a journal but no snapshot.
// ---------------------------------------------------------------------------

/** JournalRow mirror (src/journal.ts) — the fields the TUI trusts off disk. */
export interface JournalRowLite {
	type: "launched" | "started" | "result" | "failed";
	key?: string;
	agentId?: string;
	label?: string;
	phase?: string;
	error?: string;
	ts?: number;
}

/** One live run's journal, parsed into the shared progress-row shape. */
export interface JournalEvidence {
	runId: string;
	/** workflow name lifted from the persisted script.js meta literal, if any */
	name?: string;
	startedAt?: number;
	/** last row ts (epoch ms) — drives ordering and the stale hint */
	updatedAt: number;
	rows: ProgressRow[];
	agentCount: number;
}

const JOURNAL_PREVIEW_CAP = 120;

function journalPreview(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return "";
	return text.length > JOURNAL_PREVIEW_CAP ? `${text.slice(0, JOURNAL_PREVIEW_CAP)}…` : text;
}

/**
 * Parse a journal.jsonl body into evidence. Torn tails, garbage lines, and
 * unknown row types are skipped; agents are keyed by agentId in first-seen
 * order, phases in first-appearance order (mirrors supersedeRows output).
 * Returns null when nothing parseable identifies a run.
 */
export function parseJournalEvidence(raw: string, runId: string): JournalEvidence | null {
	const phases: PhaseRow[] = [];
	const phaseIndex = new Map<string, number>();
	const agents = new Map<string, AgentRow>();
	const agentOrder: string[] = [];
	let startedAt: number | undefined;
	let updatedAt = 0;

	const ensurePhase = (title: string): number => {
		const known = phaseIndex.get(title);
		if (known !== undefined) return known;
		const index = phases.length;
		phaseIndex.set(title, index);
		phases.push({ type: "workflow_phase", index, title, kind: "main" });
		return index;
	};
	const upsertAgent = (agentId: string, patch: Partial<AgentRow>): void => {
		let row = agents.get(agentId);
		if (!row) {
			row = { type: "workflow_agent", index: agentOrder.length, label: agentId, state: "start" };
			agents.set(agentId, row);
			agentOrder.push(agentId);
		}
		Object.assign(row, patch);
	};

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let rec: unknown;
		try {
			rec = JSON.parse(trimmed);
		} catch {
			continue; // torn tail from a crash in progress — ignore
		}
		if (typeof rec !== "object" || rec === null) continue;
		const row = rec as Partial<JournalRowLite>;
		if (row.type !== "launched" && row.type !== "started" && row.type !== "result" && row.type !== "failed") continue;
		const ts = typeof row.ts === "number" && Number.isFinite(row.ts) ? row.ts : undefined;
		if (ts !== undefined) updatedAt = Math.max(updatedAt, ts);
		if (row.type === "launched") {
			if (ts !== undefined) startedAt = ts; // last launched wins — resumes re-append
			continue;
		}
		if (!row.agentId) continue;
		if (row.type === "started") {
			if (startedAt === undefined && ts !== undefined) startedAt = ts;
			upsertAgent(row.agentId, {
				agentId: row.agentId,
				label: row.label ?? row.agentId,
				phaseTitle: row.phase,
				state: "progress",
			});
		} else if (row.type === "result") {
			upsertAgent(row.agentId, {
				agentId: row.agentId,
				state: "done",
				resultPreview: journalPreview((row as { result?: unknown }).result),
			});
		} else {
			upsertAgent(row.agentId, { agentId: row.agentId, state: "error", error: row.error });
		}
	}
	if (startedAt === undefined && updatedAt === 0) return null;

	for (const agent of agents.values()) {
		if (agent.phaseTitle !== undefined) agent.phaseIndex = ensurePhase(agent.phaseTitle);
	}
	return {
		runId,
		startedAt,
		updatedAt: updatedAt || startedAt || 0,
		rows: [...phases, ...[...agents.values()]],
		agentCount: agents.size,
	};
}

/** Display name from a persisted script.js — its meta literal leads the file. */
export function parseScriptName(raw: string): string | undefined {
	const head = raw.slice(0, 2000);
	const match = /name\s*:\s*['"`]([^'"`\n]{1,60})['"`]/.exec(head);
	return match?.[1];
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** One observation of a workflow tool part's metadata (S1). */
export interface PartEvidence {
	runId: string;
	sessionID: string;
	messageID: string;
	partID: string;
	/** wall-clock ms of the part's last update */
	updatedAt: number;
	/** settled part end time, once the tool call finishes */
	endedAt?: number;
	/** part.state.status — "completed" | "error" | … */
	partStatus?: string;
	/** ctx.metadata title; "workflow ▸ child […]" while a nested run is emitting */
	title?: string;
	workflowName?: string;
	nested?: boolean;
	progress: WorkflowProgress;
}

export type RunStatus = "running" | "completed" | "failed" | "killed" | "paused" | "unknown";

export interface RunView {
	runId: string;
	/** outer workflow name — snapshot.name, else first non-nested title capture */
	name: string;
	/** workflow currently writing to the part (differs from `name` inside nested runs) */
	workflowName?: string;
	nested: boolean;
	status: RunStatus;
	startedAt?: number;
	/** last evidence touch — drives the stale hint */
	updatedAt: number;
	agentCount: number;
	totalTokens: number;
	totalToolCalls: number;
	rows: ProgressRow[];
	parentSessionID?: string;
	durationMs?: number;
	error?: string;
	scriptPath?: string;
	/** live part with no update for > STALE_MS */
	stale: boolean;
	/** backed by a tool part (vs snapshot-only) */
	live: boolean;
}

export const STALE_MS = 180_000;

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

const AGENT_STATES: ReadonlySet<string> = new Set(["start", "progress", "done", "error"]);

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPhaseRow(row: Record<string, unknown>): boolean {
	return row.type === "workflow_phase" && typeof row.index === "number" && typeof row.title === "string";
}

function isAgentRow(row: Record<string, unknown>): boolean {
	return (
		row.type === "workflow_agent" &&
		typeof row.index === "number" &&
		typeof row.label === "string" &&
		typeof row.state === "string" &&
		AGENT_STATES.has(row.state)
	);
}

function isLogRow(row: Record<string, unknown>): boolean {
	return row.type === "workflow_log" && typeof row.message === "string";
}

export function parseProgress(raw: unknown): WorkflowProgress | null {
	const rec = asRecord(raw);
	if (!rec || !Array.isArray(rec.rows)) return null;
	const rows: ProgressRow[] = [];
	for (const item of rec.rows) {
		const row = asRecord(item);
		if (!row) continue;
		if (isPhaseRow(row) || isAgentRow(row) || isLogRow(row)) rows.push(item as ProgressRow);
	}
	return {
		rows,
		agentCount: asFiniteNumber(rec.agentCount) ?? rows.filter((r) => r.type === "workflow_agent").length,
		totalTokens: asFiniteNumber(rec.totalTokens) ?? 0,
		totalToolCalls: asFiniteNumber(rec.totalToolCalls) ?? 0,
	};
}

export function parseSnapshot(raw: unknown): RunSnapshotLite | null {
	const rec = asRecord(raw);
	if (!rec) return null;
	if (typeof rec.runId !== "string" || typeof rec.name !== "string") return null;
	const status = rec.status;
	if (status !== "completed" && status !== "failed" && status !== "killed" && status !== "paused") return null;
	const startedAt = asFiniteNumber(rec.startedAt);
	if (startedAt === undefined) return null;
	const progress = Array.isArray(rec.rows) ? parseProgress({ rows: rec.rows }) : null;
	const nested: RunSnapshotLite["nested"] = [];
	if (Array.isArray(rec.nested)) {
		for (const item of rec.nested) {
			const child = asRecord(item);
			if (!child || typeof child.name !== "string" || typeof child.status !== "string") continue;
			nested.push({
				name: child.name,
				status: child.status,
				rows: Array.isArray(child.rows) ? (parseProgress({ rows: child.rows })?.rows ?? []) : [],
			});
		}
	}
	return {
		runId: rec.runId,
		name: rec.name,
		description: typeof rec.description === "string" ? rec.description : undefined,
		status,
		parentSessionID: typeof rec.parentSessionID === "string" ? rec.parentSessionID : undefined,
		startedAt,
		durationMs: asFiniteNumber(rec.durationMs) ?? 0,
		scriptPath: typeof rec.scriptPath === "string" ? rec.scriptPath : undefined,
		agentCount: asFiniteNumber(rec.agentCount) ?? progress?.agentCount ?? 0,
		totalTokens: asFiniteNumber(rec.totalTokens) ?? 0,
		totalToolCalls: asFiniteNumber(rec.totalToolCalls) ?? 0,
		error: typeof rec.error === "string" ? rec.error : undefined,
		args: rec.args,
		rows: progress?.rows,
		nested: nested.length ? nested : undefined,
	};
}

/**
 * Extract workflow evidence from a tool part's `state.metadata`. Returns null
 * for any part that isn't carrying the protocol — the caller filters millions
 * of ordinary parts down to a handful this way.
 */
export function extractPartEvidence(
	metadata: unknown,
	ctx: {
		sessionID: string;
		messageID: string;
		partID: string;
		updatedAt: number;
		endedAt?: number;
		partStatus?: string;
		title?: string;
	},
): PartEvidence | null {
	const rec = asRecord(metadata);
	if (!rec) return null;
	if (typeof rec.runId !== "string" || !/^wf_[a-z0-9-]{6,}$/.test(rec.runId)) return null;
	const progress = parseProgress(rec.workflowProgress);
	if (!progress) return null;
	return {
		runId: rec.runId,
		sessionID: ctx.sessionID,
		messageID: ctx.messageID,
		partID: ctx.partID,
		updatedAt: ctx.updatedAt,
		endedAt: ctx.endedAt,
		partStatus: ctx.partStatus,
		title: ctx.title,
		workflowName: typeof rec.workflowName === "string" ? rec.workflowName : undefined,
		nested: rec.nested === true ? true : undefined,
		progress,
	};
}

/** Workflow name from a `workflow NAME [runId]` / `workflow ▸ child [runId]` title. */
export function titleWorkflowName(title: string | undefined): string | undefined {
	if (!title) return undefined;
	return /^workflow (?:▸ )?(.+?) \[/.exec(title)?.[1];
}

/** True while a nested child run is the one emitting (title `workflow ▸ child …`). */
export function isNestedTitle(title: string | undefined): boolean {
	return Boolean(title?.startsWith("workflow ▸ "));
}

function isNestedEvidence(ev: PartEvidence): boolean {
	if (ev.nested === true) return true;
	return isNestedTitle(ev.title);
}

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

/**
 * Collapse duplicate rows: one agent row per index (highest attempt wins, ties
 * to the later position) and one phase row per index (first position kept,
 * latest content). Output: phases in first-appearance order, agents grouped
 * under their phase bucket (unphased first), logs appended in order.
 */
export function supersedeRows(rows: ProgressRow[]): ProgressRow[] {
	const phaseOrder: number[] = [];
	const phases = new Map<number, PhaseRow>();
	const agents = new Map<number, { row: AgentRow; pos: number }>();
	const logs: ProgressRow[] = [];
	for (let pos = 0; pos < rows.length; pos++) {
		const row = rows[pos];
		if (row.type === "workflow_phase") {
			if (!phases.has(row.index)) phaseOrder.push(row.index);
			phases.set(row.index, row);
		} else if (row.type === "workflow_agent") {
			const prev = agents.get(row.index);
			if (prev === undefined || (row.attempt ?? 0) >= (prev.row.attempt ?? 0)) agents.set(row.index, { row, pos });
		} else if (row.type === "workflow_log") {
			logs.push(row);
		}
	}
	const phaseBucket = new Map<number, number>();
	for (const [i, index] of phaseOrder.entries()) phaseBucket.set(index, i);
	const unphased = -1;
	const unknownPhase = Number.MAX_SAFE_INTEGER;
	const sorted = [...agents.values()].sort((a, b) => {
		const pa = a.row.phaseIndex !== undefined ? (phaseBucket.get(a.row.phaseIndex) ?? unknownPhase) : unphased;
		const pb = b.row.phaseIndex !== undefined ? (phaseBucket.get(b.row.phaseIndex) ?? unknownPhase) : unphased;
		return pa !== pb ? pa - pb : a.pos - b.pos;
	});
	const out: ProgressRow[] = [];
	for (const index of phaseOrder) out.push(phases.get(index) as PhaseRow);
	for (const { row } of sorted) out.push(row);
	for (const log of logs) out.push(log);
	return out;
}

// ---------------------------------------------------------------------------
// Run assembly
// ---------------------------------------------------------------------------

/** A run's terminal state as inferred from a settled part when no snapshot exists yet. */
function deriveStatus(progress: WorkflowProgress, partStatus: string | undefined): RunStatus {
	if (partStatus === "error") return "failed";
	const agents = progress.rows.filter((r): r is AgentRow => r.type === "workflow_agent");
	if (agents.some((a) => a.state === "error")) return "failed";
	if (agents.length > 0 && agents.every((a) => a.state === "done" || a.cached || a.skipped)) return "completed";
	return "running";
}

export function buildRuns(input: {
	parts: PartEvidence[];
	snapshots: RunSnapshotLite[];
	/** live journals (run dirs with a journal but no snapshot) */
	journals?: JournalEvidence[];
	/** runId → parent sessionID, from workflow child-session metadata */
	parents?: Map<string, string>;
	/** `${runId}:${agentId}` → child sessionID (jump-to-session for live runs) */
	agentSessions?: Map<string, string>;
	now: number;
}): RunView[] {
	const parts = new Map<string, PartEvidence>();
	for (const part of input.parts) {
		const prev = parts.get(part.runId);
		if (!prev || part.updatedAt >= prev.updatedAt) parts.set(part.runId, part);
	}
	const snapshots = new Map<string, RunSnapshotLite>();
	for (const snapshot of input.snapshots) {
		const prev = snapshots.get(snapshot.runId);
		if (!prev || snapshotSettledAt(snapshot) >= snapshotSettledAt(prev)) snapshots.set(snapshot.runId, snapshot);
	}
	const journals = new Map<string, JournalEvidence>();
	for (const journal of input.journals ?? []) {
		if (!journals.has(journal.runId)) journals.set(journal.runId, journal);
	}

	const runs: RunView[] = [];
	const runIds = new Set<string>([...parts.keys(), ...snapshots.keys(), ...journals.keys()]);
	for (const runId of runIds) {
		const part = parts.get(runId);
		const snapshot = snapshots.get(runId);
		if (part) {
			// Snapshot wins only the settle race: part still "running" while a
			// settled snapshot was written after the part's last update.
			const snapshotWins =
				snapshot !== undefined && snapshotSettledAt(snapshot) > part.updatedAt && part.endedAt === undefined;
			if (!snapshotWins) {
				const nested = isNestedEvidence(part);
				const titleName = titleWorkflowName(part.title);
				const startedAt =
					snapshot?.startedAt ??
					part.progress.rows.find((r): r is AgentRow => r.type === "workflow_agent" && r.queuedAt !== undefined)
						?.queuedAt ??
					(part.endedAt !== undefined ? part.endedAt : part.updatedAt);
				// Once both artifacts exist the snapshot owns the terminal status:
				// killed/paused runs settle their part with aborted (error-state)
				// agents, which derivation alone would misread as "failed".
				const settled = part.endedAt !== undefined;
				runs.push({
					runId,
					name: nested
						? (snapshot?.name ?? "workflow")
						: (titleName ?? snapshot?.name ?? part.workflowName ?? "workflow"),
					workflowName: part.workflowName ?? titleName,
					nested,
					status: settled ? (snapshot?.status ?? deriveStatus(part.progress, part.partStatus)) : "running",
					startedAt,
					updatedAt: part.updatedAt,
					agentCount: part.progress.agentCount,
					totalTokens: part.progress.totalTokens,
					totalToolCalls: part.progress.totalToolCalls,
					rows: supersedeRows(part.progress.rows),
					parentSessionID: part.sessionID,
					durationMs: settled ? (snapshot?.durationMs ?? (part.endedAt ?? part.updatedAt) - startedAt) : undefined,
					error:
						snapshot?.error ??
						part.progress.rows.find(
							(r): r is AgentRow =>
								r.type === "workflow_agent" && r.state === "error" && typeof r.error === "string",
						)?.error,
					scriptPath: snapshot?.scriptPath,
					stale: !settled && input.now - part.updatedAt > STALE_MS,
					live: !settled,
				});
				continue;
			}
		}
		if (snapshot) {
			runs.push({
				runId,
				name: snapshot.name,
				nested: false,
				status: snapshot.status,
				startedAt: snapshot.startedAt,
				updatedAt: snapshotSettledAt(snapshot),
				agentCount: snapshot.agentCount,
				totalTokens: snapshot.totalTokens,
				totalToolCalls: snapshot.totalToolCalls,
				rows: supersedeRows(snapshot.rows ?? []),
				parentSessionID: snapshot.parentSessionID,
				durationMs: snapshot.durationMs,
				error: snapshot.error,
				scriptPath: snapshot.scriptPath,
				stale: false,
				live: false,
			});
			continue;
		}
		// live run discovered by its journal (parts only arrive at settle)
		const journal = journals.get(runId);
		if (journal) {
			const rows = journal.rows.map((row) => {
				if (row.type !== "workflow_agent" || row.agentId === undefined) return row;
				const sessionId = input.agentSessions?.get(`${runId}:${row.agentId}`);
				return sessionId === undefined ? row : { ...row, sessionId };
			});
			runs.push({
				runId,
				name: journal.name ?? "workflow",
				nested: false,
				status: "running",
				startedAt: journal.startedAt,
				updatedAt: journal.updatedAt,
				agentCount: journal.agentCount,
				totalTokens: 0,
				totalToolCalls: 0,
				rows,
				parentSessionID: input.parents?.get(runId),
				stale: journal.updatedAt > 0 && input.now - journal.updatedAt > STALE_MS,
				live: true,
			});
		}
	}
	runs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	return runs;
}

// ---------------------------------------------------------------------------
// Dashboard flattening
// ---------------------------------------------------------------------------

export type DashboardFilter = "all" | "running" | "done" | "error";

export interface FlatPhaseRow {
	kind: "phase";
	phase: PhaseRow;
	total: number;
	visible: number;
}

export interface FlatAgentRow {
	kind: "agent";
	agent: AgentRow;
}

export interface FlatLogRow {
	kind: "log";
	message: string;
}

export type FlatRow = FlatPhaseRow | FlatAgentRow | FlatLogRow;

function agentMatchesFilter(agent: AgentRow, filter: DashboardFilter): boolean {
	switch (filter) {
		case "running":
			return (agent.state === "start" || agent.state === "progress") && !agent.cached && !agent.skipped;
		case "done":
			return agent.state === "done" || agent.cached === true || agent.skipped === true;
		case "error":
			return agent.state === "error";
		case "all":
			return true;
	}
}

export function flattenRun(run: RunView, opts?: { filter?: DashboardFilter; showLogs?: boolean }): FlatRow[] {
	const filter = opts?.filter ?? "all";
	const showLogs = opts?.showLogs ?? false;
	const rows = run.rows;

	// Group by explicit phaseIndex — supersedeRows emits all phases before the
	// agents, so walk order can't be trusted for bucketing.
	const phases: PhaseRow[] = [];
	const buckets = new Map<number, { phase: PhaseRow; agents: AgentRow[] }>();
	for (const row of rows) {
		if (row.type === "workflow_phase" && !buckets.has(row.index)) {
			const bucket = { phase: row, agents: [] };
			buckets.set(row.index, bucket);
			phases.push(row);
		}
	}
	const unphased: AgentRow[] = [];
	for (const row of rows) {
		if (row.type !== "workflow_agent") continue;
		const bucket = row.phaseIndex !== undefined ? buckets.get(row.phaseIndex) : undefined;
		if (bucket) bucket.agents.push(row);
		else unphased.push(row);
	}

	const out: FlatRow[] = [];
	const emit = (agents: AgentRow[], phase?: PhaseRow) => {
		const visible = agents.filter((agent) => agentMatchesFilter(agent, filter));
		if (filter !== "all" && visible.length === 0 && agents.length > 0) return;
		if (phase) out.push({ kind: "phase", phase, total: agents.length, visible: visible.length });
		for (const agent of visible) out.push({ kind: "agent", agent });
	};
	emit(unphased);
	for (const phase of phases) {
		emit(buckets.get(phase.index)?.agents ?? [], phase);
	}
	if (showLogs) {
		for (const row of rows) {
			if (row.type === "workflow_log") out.push({ kind: "log", message: row.message });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Inline panel (session_prompt slot) — the composer-adjacent status card
// ---------------------------------------------------------------------------

export interface InlinePhaseView {
	title: string;
	done: number;
	total: number;
	agents: AgentRow[];
}

export interface InlineView {
	runId: string;
	name: string;
	status: RunStatus;
	stale: boolean;
	done: number;
	agentCount: number;
	totalTokens: number;
	/** phase buckets in first-appearance order; unphased agents lead under a synthetic bucket */
	phases: InlinePhaseView[];
}

const inlineDone = (agents: AgentRow[]): number =>
	agents.filter((agent) => agent.state === "done" || agent.cached || agent.skipped).length;

/**
 * Collapse a run into the inline card's shape: phase buckets (left column)
 * each carrying their agents (right column). Agents without a phase bucket
 * lead under a synthetic bucket — "run" when the script declared no phases,
 * "prep" when they precede the first declared one.
 */
export function buildInlineView(run: RunView): InlineView {
	const phases: PhaseRow[] = [];
	const buckets = new Map<number, AgentRow[]>();
	for (const row of run.rows) {
		if (row.type === "workflow_phase" && !buckets.has(row.index)) {
			buckets.set(row.index, []);
			phases.push(row);
		}
	}
	const unphased: AgentRow[] = [];
	for (const row of run.rows) {
		if (row.type !== "workflow_agent") continue;
		const bucket = row.phaseIndex !== undefined ? buckets.get(row.phaseIndex) : undefined;
		if (bucket) bucket.push(row);
		else unphased.push(row);
	}
	const groups: InlinePhaseView[] = [];
	if (unphased.length > 0) {
		groups.push({
			title: phases.length > 0 ? "prep" : "run",
			done: inlineDone(unphased),
			total: unphased.length,
			agents: unphased,
		});
	}
	for (const phase of phases) {
		const agents = buckets.get(phase.index) ?? [];
		groups.push({ title: phase.title, done: inlineDone(agents), total: agents.length, agents });
	}
	return {
		runId: run.runId,
		name: run.name,
		status: run.status,
		stale: run.stale,
		done: doneCount(run),
		agentCount: run.agentCount,
		totalTokens: run.totalTokens,
		phases: groups,
	};
}

// ---------------------------------------------------------------------------
// Glyphs + formatters (pinned here so render and tests agree)

/** Agents finished (done, cached, or skipped) — the done/total counters. */
export function doneCount(run: RunView): number {
	return run.rows.filter(
		(row): row is AgentRow =>
			row.type === "workflow_agent" && Boolean(row.state === "done" || row.cached || row.skipped),
	).length;
}
// ---------------------------------------------------------------------------

export function agentGlyph(agent: { state: AgentRowState; cached?: boolean; skipped?: boolean }): string {
	if (agent.skipped) return "◦";
	if (agent.cached) return "↻";
	switch (agent.state) {
		case "done":
			return "✔";
		case "error":
			return "✗";
		case "progress":
			return "◐";
		case "start":
			return "○";
	}
}

export function runGlyph(status: RunStatus): string {
	switch (status) {
		case "running":
			return "◐";
		case "completed":
			return "✔";
		case "failed":
			return "✗";
		case "killed":
			return "⊘";
		case "paused":
			return "⏸";
		case "unknown":
			return "·";
	}
}

export function fmtTokens(tokens: number | undefined): string {
	if (tokens === undefined || !Number.isFinite(tokens)) return "";
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}
