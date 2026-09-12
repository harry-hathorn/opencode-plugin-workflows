/**
 * Workflow executor: runs a compiled script inside the sandbox with the runtime API installed, enforcing caps,
 * budget, journaling, cache/resume semantics, and progress reporting.
 */
import * as os from "node:os";
import type { CompiledWorkflow } from "./compile";
import { cacheKey, type Journal, type LoadedJournal, newAgentId, stableStringify } from "./journal";
import { agentCapError, budgetExceededError } from "./prompts";
import { createFallbackSandbox, createSandbox, type Sandbox, type SandboxHooks } from "./sandbox";

// ---------------------------------------------------------------------------
// Errors with distinct identities — abort/cap escape parallel()/pipeline();
// budget errors convert to null slots.
// ---------------------------------------------------------------------------

export class WorkflowAbortError extends Error {
	constructor(
		message: string,
		public readonly reason: string,
	) {
		super(message);
		this.name = "WorkflowAbortError";
	}
}

export class WorkflowAgentCapError extends Error {
	constructor() {
		super(agentCapError);
		this.name = "WorkflowAgentCapError";
	}
}

export class WorkflowBudgetExceededError extends Error {
	constructor(spent: number, total: number) {
		super(budgetExceededError(spent, total));
		this.name = "WorkflowBudgetExceededError";
	}
}

function isFatal(err: unknown): boolean {
	if (err instanceof WorkflowAbortError || err instanceof WorkflowAgentCapError) return true;
	// sandbox-tagged aborts (see asAbortError) escape barriers too
	return err instanceof Error && err.name === "WorkflowAbortError";
}

/**
 * Normalize abort failures: the sandbox reports aborts as plain Errors tagged
 * `name === "WorkflowAbortError"` (sandbox.ts cannot import this module).
 */
function asAbortError(err: unknown): WorkflowAbortError | null {
	if (err instanceof WorkflowAbortError) return err;
	if (err instanceof Error && err.name === "WorkflowAbortError") {
		const reason = (err as Error & { reason?: string }).reason ?? "interrupt";
		return new WorkflowAbortError(err.message, reason);
	}
	return null;
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// ---------------------------------------------------------------------------
// Caps (§5.7)
// ---------------------------------------------------------------------------

export function maxConcurrentAgents(): number {
	const env = Number.parseInt(process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS ?? "", 10);
	if (Number.isFinite(env) && env > 0) return env;
	return Math.min(16, Math.max(2, os.cpus().length - 2));
}

export const MAX_AGENTS_PER_RUN = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const SYNC_WATCHDOG_MS = 30_000;
export const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ---------------------------------------------------------------------------
// Progress protocol (§6)
// ---------------------------------------------------------------------------

export type AgentRowState = "start" | "progress" | "done" | "error";

export interface WorkflowPhaseRow {
	type: "workflow_phase";
	index: number;
	title: string;
	kind: "main" | "child";
}

export interface WorkflowAgentRow {
	type: "workflow_agent";
	index: number;
	label: string;
	phaseIndex?: number;
	phaseTitle?: string;
	agentId?: string;
	/** worker session id once created (TUI correlation) */
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

export interface WorkflowLogRow {
	type: "workflow_log";
	message: string;
}

export type ProgressRow = WorkflowPhaseRow | WorkflowAgentRow | WorkflowLogRow;

export interface WorkflowProgress {
	rows: ProgressRow[];
	agentCount: number;
	totalTokens: number;
	totalToolCalls: number;
}

const LOG_ROW_CAP = 500;
const PREVIEW_CAP = 400;

function preview(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (stableStringify(value) ?? "null");
	} catch {
		text = String(value);
	}
	return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}…` : text;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

export class Semaphore {
	private active = 0;
	private readonly queue: Array<{ resolve: () => void; reject: (err: Error) => void; onAbort: () => void }> = [];

	constructor(private readonly limit: number) {}

	async acquire(signal: AbortSignal): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		if (signal.aborted) throw abortError(signal);
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(abortError(signal));
			this.queue.push({ resolve, reject, onAbort });
			signal.addEventListener("abort", onAbort, { once: true });
		});
		// resolved by release() which already incremented `active`
	}

	release(): void {
		const next = this.queue.shift();
		if (!next) {
			this.active = Math.max(0, this.active - 1);
			return;
		}
		// hand the slot directly to the waiter
		next.resolve();
	}

	abortAll(signal: AbortSignal): void {
		while (this.queue.length) {
			const next = this.queue.shift()!;
			signal.removeEventListener("abort", next.onAbort);
			next.reject(abortError(signal));
		}
	}
}

function abortError(signal: AbortSignal): WorkflowAbortError {
	const reason = (signal.reason as string | undefined) ?? "interrupt";
	return new WorkflowAbortError(`Workflow aborted (${reason})`, reason);
}

// ---------------------------------------------------------------------------
// Agent API types
// ---------------------------------------------------------------------------

export interface AgentOptions {
	label?: string;
	phase?: string;
	schema?: Record<string, unknown>;
	model?: string;
	effort?: string;
	isolation?: "worktree" | "remote";
	agentType?: string;
	disallowedTools?: string[];
	bashCommandClamp?: string[];
	stallMs?: number;
}

export interface AgentCall {
	key: string;
	agentId: string;
	index: number;
	runId: string;
	signal: AbortSignal;
	/** live progress updates from the agent machinery */
	report(patch: Partial<WorkflowAgentRow>): void;
	addTokens(outputTokens: number): void;
	addToolCalls(count: number): void;
}

/** null = terminal failure (agent() returns null to the script). */
export type AgentFn = (prompt: string, opts: AgentOptions, call: AgentCall) => Promise<{ value: unknown } | null>;

// ---------------------------------------------------------------------------
// Run config & outcome
// ---------------------------------------------------------------------------

export interface RunConfig {
	runId: string;
	compiled: CompiledWorkflow;
	args: unknown;
	agent: AgentFn;
	journal: Journal;
	resume?: LoadedJournal;
	onProgress?: (progress: WorkflowProgress) => void;
	signal?: AbortSignal;
	budgetTotal?: number | null;
	/** resolve+run a child workflow (one level); shares caps/journal/budget */
	nestedWorkflow?: (nameOrRef: string | { scriptPath: string }, args: unknown) => Promise<unknown>;
	/** state shared with nested workflow() children (counter, semaphore, budget pool) */
	shared?: SharedRunState;
	/** test seam */
	maxAgents?: number;
}

export type RunStatus = "completed" | "failed" | "killed" | "paused";

/**
 * Mutable execution state shared between a parent run and its workflow()
 * children: one agent counter, one concurrency semaphore, one token pool.
 * Created by the host (tool.ts) and passed via RunConfig.shared to both the
 * parent and every nested executeWorkflow call.
 */
export interface SharedRunState {
	agentCounter: { count: number };
	tokens: { spent: number };
	semaphore: Semaphore;
}

export function createSharedRunState(): SharedRunState {
	return { agentCounter: { count: 0 }, tokens: { spent: 0 }, semaphore: new Semaphore(maxConcurrentAgents()) };
}

export interface RunOutcome {
	status: RunStatus;
	result?: unknown;
	error?: string;
	progress: WorkflowProgress;
	durationMs: number;
	failures: string[];
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeWorkflow(cfg: RunConfig): Promise<RunOutcome> {
	const startedAt = Date.now();
	const rows: ProgressRow[] = [];
	const agentRows = new Map<number, WorkflowAgentRow>();
	const phaseRows = new Map<string, WorkflowPhaseRow>();
	const failures: string[] = [];
	let prevKey = "";
	let live = false; // once true, no further cache reads (reordered-call safety)
	let currentPhase: string | undefined;
	const maxAgents = cfg.maxAgents ?? MAX_AGENTS_PER_RUN;
	const budgetTotal = cfg.budgetTotal ?? null;
	const signal = cfg.signal ?? new AbortController().signal;
	// Nested workflow() children share the parent's counter/semaphore/token pool.
	const counter = cfg.shared?.agentCounter ?? { count: 0 };
	const tokenPool = cfg.shared?.tokens ?? { spent: 0 };
	const semaphore = cfg.shared?.semaphore ?? new Semaphore(maxConcurrentAgents());

	// --- progress plumbing (debounced emit) ---
	let emitScheduled = false;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	const buildProgress = (): WorkflowProgress => {
		let totalTokens = 0;
		let totalToolCalls = 0;
		for (const row of agentRows.values()) {
			totalTokens += row.tokens ?? 0;
			totalToolCalls += row.toolCalls ?? 0;
		}
		return {
			rows: [...rows],
			agentCount: agentRows.size,
			totalTokens,
			totalToolCalls,
		};
	};
	const emitNow = () => {
		emitScheduled = false;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		cfg.onProgress?.(buildProgress());
	};
	const emit = (immediate = false) => {
		if (!cfg.onProgress) return;
		if (immediate) {
			emitNow();
			return;
		}
		if (emitScheduled) return;
		emitScheduled = true;
		flushTimer = setTimeout(emitNow, 100);
	};

	const log = (message: string) => {
		rows.push({ type: "workflow_log", message });
		// compaction: drop oldest logs beyond the cap
		let logCount = 0;
		for (let i = rows.length - 1; i >= 0; i--) if (rows[i].type === "workflow_log") logCount++;
		if (logCount > LOG_ROW_CAP * 2) {
			let toDrop = logCount - LOG_ROW_CAP;
			for (let i = 0; i < rows.length && toDrop > 0; i++) {
				if (rows[i].type === "workflow_log") {
					rows.splice(i, 1);
					i--;
					toDrop--;
				}
			}
		}
		emit();
	};

	// --- phase rows: seed from meta.phases upfront ---
	const normalizeTitle = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
	let phaseIndexCounter = 0;
	const ensurePhaseRow = (title: string): WorkflowPhaseRow => {
		const norm = normalizeTitle(title);
		for (const row of phaseRows.values()) if (normalizeTitle(row.title) === norm) return row;
		const row: WorkflowPhaseRow = { type: "workflow_phase", index: phaseIndexCounter++, title, kind: "main" };
		phaseRows.set(title, row);
		rows.push(row);
		emit();
		return row;
	};
	for (const p of cfg.compiled.meta.phases ?? []) ensurePhaseRow(p.title);

	// --- sandbox + hooks ---
	let sandbox: Sandbox;
	const hooks: SandboxHooks = {
		agent: undefined as unknown as SandboxHooks["agent"],
		parallel: undefined as unknown as SandboxHooks["parallel"],
		pipeline: undefined as unknown as SandboxHooks["pipeline"],
		workflow: undefined as unknown as SandboxHooks["workflow"],
		log: (message: string) => log(String(message)),
		phase: (title: string) => {
			currentPhase = String(title);
			ensurePhaseRow(currentPhase);
		},
		budget: Object.freeze(
			Object.create(null, {
				total: { value: budgetTotal, enumerable: true },
				spent: { value: () => tokenPool.spent, enumerable: true },
				remaining: {
					value: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - tokenPool.spent)),
					enumerable: true,
				},
			}),
		),
		args: cfg.args,
	};

	const upsertAgentRow = (index: number, patch: Partial<WorkflowAgentRow>) => {
		const existing = agentRows.get(index);
		if (existing) Object.assign(existing, patch);
		else {
			const row = Object.assign<WorkflowAgentRow, Partial<WorkflowAgentRow>>(
				{ type: "workflow_agent", state: "start", label: "", index },
				patch,
			);
			agentRows.set(index, row);
			rows.push(row);
		}
		const terminal = (patch.state ?? "start") === "done" || (patch.state ?? "start") === "error";
		emit(terminal);
	};

	// --- agent() implementation ---
	const agentImpl = async (rawPrompt: unknown, rawOpts?: unknown): Promise<unknown> => {
		if (typeof rawPrompt !== "string") throw new TypeError("agent() requires a string prompt");
		const opts: AgentOptions = (rawOpts ?? {}) as AgentOptions;
		if (typeof opts !== "object" || opts === null) throw new TypeError("agent() options must be an object");
		if (opts.schema !== undefined) {
			const schema = opts.schema as { type?: string; properties?: unknown } | null;
			if (typeof schema !== "object" || schema === null || schema.type !== "object") {
				throw new Error(
					"agent({schema}): schema root must be {type:'object', properties:{...}} — unsatisfiable schemas are refused at call time",
				);
			}
		}
		if (opts.effort !== undefined && !VALID_EFFORTS.has(opts.effort)) {
			throw new TypeError(
				`agent() effort must be one of low|medium|high|xhigh|max (got ${JSON.stringify(opts.effort)})`,
			);
		}
		if (opts.isolation !== undefined && opts.isolation !== "worktree") {
			throw new Error("agent({isolation:'remote'}) is not available in this build");
		}
		if (signal.aborted) throw abortError(signal);

		counter.count++;
		if (counter.count > maxAgents) throw new WorkflowAgentCapError();
		if (budgetTotal !== null && tokenPool.spent >= budgetTotal) {
			throw new WorkflowBudgetExceededError(tokenPool.spent, budgetTotal);
		}

		const key = cacheKey(rawPrompt, opts as Record<string, unknown>, prevKey);
		prevKey = key;
		const index = counter.count - 1;
		const label = (opts.label ?? rawPrompt.replace(/\s+/g, " ")).slice(0, 60) || `agent-${index}`;
		const phaseTitle = opts.phase ?? currentPhase;
		const phaseRow = phaseTitle ? ensurePhaseRow(phaseTitle) : undefined;

		// --- cache hit (resume) ---
		if (!live && cfg.resume && cfg.resume.results.has(key)) {
			const cached = cfg.resume.results.get(key);
			upsertAgentRow(index, {
				type: "workflow_agent",
				index,
				label,
				phaseIndex: phaseRow?.index,
				phaseTitle,
				state: "done",
				cached: true,
				resultPreview: preview(cached),
			});
			return cloneForSandbox(cached);
		}
		live = true;

		// --- live spawn ---
		const agentId = newAgentId();
		const queuedAt = Date.now();
		cfg.journal.append({ type: "started", key, agentId, label, phase: phaseTitle });
		upsertAgentRow(index, {
			type: "workflow_agent",
			index,
			label,
			phaseIndex: phaseRow?.index,
			phaseTitle,
			agentId,
			agentType: opts.agentType,
			model: opts.model,
			isolation: opts.isolation,
			state: "start",
			queuedAt,
			promptPreview: preview(rawPrompt),
		});

		await semaphore.acquire(signal);
		const startedAtMs = Date.now();
		upsertAgentRow(index, { state: "progress", startedAt: startedAtMs });
		let rowTokens = 0;
		let rowToolCalls = 0;
		try {
			const result = await cfg.agent(rawPrompt, opts, {
				key,
				agentId,
				index,
				runId: cfg.runId,
				signal,
				report: (patch) => upsertAgentRow(index, patch),
				addTokens: (n) => {
					tokenPool.spent += Math.max(0, n | 0);
					rowTokens += Math.max(0, n | 0);
				},
				addToolCalls: (n) => {
					rowToolCalls += Math.max(0, n | 0);
				},
			});
			if (result === null) {
				cfg.journal.append({ type: "failed", key, agentId });
				upsertAgentRow(index, {
					state: "error",
					tokens: rowTokens,
					toolCalls: rowToolCalls,
					durationMs: Date.now() - queuedAt,
				});
				return null;
			}
			cfg.journal.append({ type: "result", key, agentId, result: result.value });
			upsertAgentRow(index, {
				state: "done",
				tokens: rowTokens,
				toolCalls: rowToolCalls,
				durationMs: Date.now() - queuedAt,
				resultPreview: preview(result.value),
			});
			return cloneForSandbox(result.value);
		} finally {
			semaphore.release();
		}
	};

	// --- parallel() (§5.2) ---
	const parallelImpl = async (thunks: unknown): Promise<unknown[]> => {
		if (!Array.isArray(thunks)) {
			throw new TypeError(
				"parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
			);
		}
		if (thunks.length > MAX_ITEMS_PER_CALL) {
			throw new Error(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items per call (${thunks.length} given)`);
		}
		for (const t of thunks) {
			if (typeof t !== "function") {
				throw new TypeError(
					"parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
				);
			}
		}
		if (thunks.length === 0) return [];
		const settled = await Promise.allSettled(thunks.map((t) => Promise.resolve().then(() => (t as () => unknown)())));
		for (const s of settled) {
			if (s.status === "rejected" && isFatal(s.reason)) throw s.reason;
		}
		let budgetDropped = 0;
		const out = settled.map((s, i) => {
			if (s.status === "fulfilled") return s.value;
			if (s.reason instanceof WorkflowBudgetExceededError) {
				budgetDropped++;
				return null;
			}
			log(`parallel[${i}] failed: ${errMessage(s.reason)}`);
			failures.push(`parallel[${i}]: ${errMessage(s.reason)}`);
			return null;
		});
		if (budgetDropped > 0) log(`parallel: ${budgetDropped} slots dropped — token budget exceeded`);
		return out;
	};

	// --- pipeline() (§5.3) ---
	const pipelineImpl = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
		if (!Array.isArray(items)) {
			throw new TypeError("pipeline(items, ...stages) expects an array as its first argument");
		}
		if (stages.length === 0) {
			throw new TypeError("pipeline(items, ...stages) requires at least one stage function");
		}
		for (const s of stages) {
			if (typeof s !== "function") throw new TypeError("pipeline stages must be functions");
		}
		if (items.length > MAX_ITEMS_PER_CALL) {
			throw new Error(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items per call (${items.length} given)`);
		}
		return Promise.all(
			items.map(async (item, i): Promise<unknown> => {
				let v: unknown = item;
				for (const stage of stages as Array<(prev: unknown, item: unknown, index: number) => unknown>) {
					if (v === null) break;
					try {
						v = await stage(v, item, i);
					} catch (err) {
						if (isFatal(err)) throw err;
						if (err instanceof WorkflowBudgetExceededError) {
							log(`pipeline[${i}]: token budget exceeded — slot dropped`);
							return null;
						}
						log(`pipeline[${i}] failed: ${errMessage(err)}`);
						failures.push(`pipeline[${i}]: ${errMessage(err)}`);
						return null;
					}
					if (v === null) break;
				}
				return v;
			}),
		);
	};

	// --- workflow() nesting (§5.6, one level) ---
	let inChildWorkflow = false;
	const workflowImpl = async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
		if (inChildWorkflow) throw new Error("workflow() can only be nested one level deep");
		if (!cfg.nestedWorkflow) {
			throw new Error("workflow() is not available in this context (no workflow registry)");
		}
		if (
			typeof nameOrRef !== "string" &&
			!(typeof nameOrRef === "object" && nameOrRef !== null && "scriptPath" in nameOrRef)
		) {
			throw new TypeError("workflow() expects a saved-workflow name or {scriptPath}");
		}
		inChildWorkflow = true;
		try {
			return await cfg.nestedWorkflow(nameOrRef as string | { scriptPath: string }, childArgs);
		} finally {
			inChildWorkflow = false;
		}
	};

	hooks.agent = agentImpl as SandboxHooks["agent"];
	hooks.parallel = parallelImpl;
	hooks.pipeline = pipelineImpl as SandboxHooks["pipeline"];
	hooks.workflow = workflowImpl;

	// --- build sandbox ---
	try {
		sandbox = createSandbox(hooks, signal);
	} catch {
		sandbox = createFallbackSandbox(hooks, cfg.compiled.iifeSource, signal);
	}
	const onAbortRun = () => {
		sandbox.timers.clearAll();
		semaphore.abortAll(signal);
	};
	signal.addEventListener("abort", onAbortRun, { once: true });

	// --- journal history ---
	if (cfg.resume) {
		cfg.journal.replicate(cfg.resume.rows);
	} else {
		cfg.journal.append({ type: "launched" });
	}

	// --- run ---
	let status: RunStatus;
	let result: unknown;
	let error: string | undefined;
	try {
		const value = await sandbox.run(cfg.compiled.script, SYNC_WATCHDOG_MS);
		if (typeof value === "function") {
			throw new Error("workflow result cannot be a function");
		}
		status = "completed";
		result = cloneForSandbox(value);
	} catch (err) {
		const abort = asAbortError(err);
		if (abort) {
			status = abort.reason === "user-pause" ? "paused" : "killed";
			error = abort.message;
		} else {
			status = "failed";
			error = errMessage(err);
		}
	} finally {
		signal.removeEventListener("abort", onAbortRun);
		emitNow();
	}

	return {
		status,
		result,
		error,
		progress: buildProgress(),
		durationMs: Date.now() - startedAt,
		failures: failures.slice(0, 50),
	};
}

/** JSON round-trip clone — values crossing the sandbox boundary in either direction. */
export function cloneForSandbox(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
}
