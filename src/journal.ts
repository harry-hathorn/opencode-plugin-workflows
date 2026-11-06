/**
 * Journal & run-artifact storage under opencode's data dir:
 *
 *   ~/.local/share/opencode/workflows/<runId>/
 *     journal.jsonl        # {launched|started|result|failed} rows (ts, error), resume cache
 *     script.js            # persisted script for this invocation
 *     snapshot.json        # written on settle (status, result, progress rows)
 *     control.jsonl        # TUI → server control ops (kill/pause), 0600
 *
 * Cache keys are chained: v2:sha256(prompt \0 canonicalOpts \0 prevKey) — editing
 * agent N's prompt/opts invalidates every subsequent key, which is what makes
 * resume a "longest unchanged prefix".
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Run-directory layout lives in paths.ts so the TUI bundle can share it.
export { journalPath, runDir, runsRoot } from "./paths";

/** `wf_` + first 12 chars of a UUID. */
export function newRunId(): string {
	return `wf_${crypto.randomUUID().slice(0, 12)}`;
}

export function newAgentId(): string {
	return crypto.randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// Canonical opts + chained cache key
// ---------------------------------------------------------------------------

/** Keys that participate in the cache key. `label` and `phase` are cosmetic → excluded. */
const KEYED_OPTS = ["schema", "model", "effort", "isolation", "agentType", "disallowedTools", "bashCommandClamp"];

/** Stable stringify: recursively sorted keys; functions dropped (objects) / nulled (arrays). */
export function stableStringify(value: unknown): string {
	const seen = new Set<unknown>();
	const walk = (v: unknown): unknown => {
		if (typeof v === "function") return undefined;
		if (v === null || typeof v !== "object") return v;
		if (seen.has(v)) return "[Circular]";
		seen.add(v);
		if (Array.isArray(v)) return v.map((el) => (typeof el === "function" ? null : walk(el)));
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(v as Record<string, unknown>).sort()) {
			const el = (v as Record<string, unknown>)[key];
			if (typeof el === "function") continue;
			out[key] = walk(el);
		}
		return out;
	};
	return JSON.stringify(walk(value));
}

export function canonicalOpts(opts: Record<string, unknown>): string {
	const picked: Record<string, unknown> = {};
	for (const key of KEYED_OPTS) if (opts[key] !== undefined) picked[key] = opts[key];
	return stableStringify(picked);
}

export function cacheKey(prompt: string, opts: Record<string, unknown>, prevKey: string): string {
	const hash = crypto.createHash("sha256");
	hash.update(prompt);
	hash.update("\0");
	hash.update(canonicalOpts(opts));
	hash.update("\0");
	hash.update(prevKey);
	return `v2:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Journal rows
// ---------------------------------------------------------------------------

export interface JournalRow {
	type: "launched" | "started" | "result" | "failed";
	key?: string;
	agentId?: string;
	label?: string;
	phase?: string;
	result?: unknown;
	error?: string;
	/** epoch ms at append — lets readers order rows without filesystem clocks */
	ts?: number;
}

export interface LoadedJournal {
	/** key → agent return value (host-cloned) */
	results: Map<string, unknown>;
	started: Set<string>;
	failed: Set<string>;
	rows: JournalRow[];
}

export class Journal {
	constructor(private readonly file: string) {}

	append(row: JournalRow): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
	}

	/** Copy a previous run's rows into this journal (resume keeps the chain complete). */
	replicate(rows: JournalRow[]): void {
		for (const row of rows) this.append(row);
	}

	static load(file: string): LoadedJournal {
		const empty: LoadedJournal = { results: new Map(), started: new Set(), failed: new Set(), rows: [] };
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return empty;
		}
		const loaded: LoadedJournal = { results: new Map(), started: new Set(), failed: new Set(), rows: [] };
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let row: JournalRow;
			try {
				row = JSON.parse(trimmed) as JournalRow;
			} catch {
				continue; // torn tail line from a crash — ignore
			}
			loaded.rows.push(row);
			if (row.type === "started" && row.key) loaded.started.add(row.key);
			if (row.type === "result" && row.key) loaded.results.set(row.key, row.result);
			if (row.type === "failed" && row.key) loaded.failed.add(row.key);
		}
		return loaded;
	}
}

/** Validate a resume runId (loose `^wf_[a-z0-9-]{6,}$` — hex + dashes from UUID slice). */
export function isValidRunId(runId: string): boolean {
	return /^wf_[a-z0-9-]{6,}$/.test(runId);
}

/** Prevent path escape through a user-supplied runId. */
export function safeRunId(runId: string): string | null {
	if (!isValidRunId(runId)) return null;
	if (runId.includes("..") || runId.includes("/")) return null;
	return runId;
}
