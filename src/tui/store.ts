/**
 * Reactive glue between the TUI plugin API and the pure data layer:
 *
 *  S1   workflow tool calls — "session.tool.progress" events (live) and
 *                             "session.tool.success"/"failed" (settle) carry
 *                             the tool's progress metadata {runId,
 *                             workflowProgress, workflowName, nested, title}
 *  S1b  live journals       — run dirs with journal.jsonl but no snapshot.json;
 *                             journal rows land synchronously during the run, so
 *                             live runs are visible from launch (the control
 *                             bridge's target picker)
 *  S2   child-session map   — "session.created" events carry {runId, agentId}
 *                             metadata, attributing live runs to their parent
 *                             session and agents to their worker sessions
 *  S3   settled snapshots   — direct fs read of the runs dir, capped, refreshed
 *                             on settle and every few seconds
 *  tick                      — 1s heartbeat so elapsed/stale recompute live
 *
 * Everything funnels into buildRuns(); consumers (sidebar, dashboard) only read
 * `runs()` inside reactive scopes. The store owns no JSX and no routes.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "@opencode/plugin/tui";

type TuiContext = Plugin.Context;

import { createMemo, createSignal } from "solid-js";
import { appendControlLine, runsRoot } from "../paths";
import {
	buildRuns,
	extractPartEvidence,
	type JournalEvidence,
	type PartEvidence,
	parseJournalEvidence,
	parseScriptName,
	parseSnapshot,
	type RunSnapshotLite,
	type RunView,
} from "./data";

const SNAPSHOT_CAP = 50;
const SNAPSHOT_DEBOUNCE_MS = 500;
const REFRESH_EVERY_N_TICKS = 5;
/** inline-panel heartbeat granularity — keeps the composer-adjacent render cheap */
const COARSE_MS = 30_000;

export interface WorkflowStore {
	/** all known runs, newest evidence first (reactive) */
	readonly runs: () => RunView[];
	/** newest run whose parent session matches — the sidebar's pick */
	latestForSession(sessionID: string): RunView | undefined;
	/**
	 * Newest LIVE run for the session, derived at evidence frequency (plus a
	 * coarse 30s heartbeat only while something runs) — the inline panel's
	 * pick. Settled runs vanish, matching the "bullet disappears when done"
	 * contract.
	 */
	inlineLatest(sessionID: string): RunView | undefined;
	/** coarse heartbeat in epoch ms (30s granularity) — inline elapsed timers */
	readonly coarseNow: () => number;
	/** 1s heartbeat in epoch ms — elapsed timers and stale hints */
	readonly tick: () => number;
	/** seed evidence for a session that ran workflows before this TUI started */
	scanSession(sessionID: string): void;
	/** force a snapshot + journal re-read (debounced) */
	refreshRuns(): void;
	/** append a control op to the run's control.jsonl; truth arrives via updates */
	control(runId: string, op: "kill" | "pause"): boolean;
	dispose(): void;
}

export function createWorkflowStore(context: TuiContext): WorkflowStore {
	const [partVersion, setPartVersion] = createSignal(0);
	const [snapshotList, setSnapshotList] = createSignal<RunSnapshotLite[]>([]);
	const [journalList, setJournalList] = createSignal<JournalEvidence[]>([]);
	const [sessionVersion, setSessionVersion] = createSignal(0);
	const [tickValue, setTickValue] = createSignal(Date.now());
	const partsByRun = new Map<string, PartEvidence>();
	let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	let tickCount = 0;

	// -- S3 + S1b: snapshots + live journals ------------------------------------

	function readRunDirs(): { snapshots: RunSnapshotLite[]; journals: JournalEvidence[] } {
		const root = runsRoot();
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			return { snapshots: [], journals: [] };
		}
		const snapshots: RunSnapshotLite[] = [];
		const journals: JournalEvidence[] = [];
		for (const entry of entries) {
			if (!entry.startsWith("wf_")) continue;
			const dir = path.join(root, entry);
			// settled runs read from the snapshot; dirs without one are live (or
			// crashed pre-settle) — their journal is the progress log
			let snapshot: RunSnapshotLite | null = null;
			try {
				snapshot = parseSnapshot(JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8")));
			} catch {
				snapshot = null; // missing or torn snapshot — settle write in progress
			}
			if (snapshot) {
				snapshots.push(snapshot);
				continue;
			}
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
			} catch {
				continue; // neither artifact — not ours to show
			}
			const journal = parseJournalEvidence(raw, entry);
			if (!journal) continue;
			try {
				journal.name = parseScriptName(fs.readFileSync(path.join(dir, "script.js"), "utf8"));
			} catch {
				// script unpersisted (or already gone) — fall back to "workflow"
			}
			journals.push(journal);
		}
		snapshots.sort((a, b) => b.startedAt - a.startedAt);
		return { snapshots: snapshots.slice(0, SNAPSHOT_CAP), journals: journals.slice(0, SNAPSHOT_CAP) };
	}

	function refreshRuns(): void {
		if (snapshotTimer !== undefined) return; // already scheduled — debounce
		snapshotTimer = setTimeout(() => {
			snapshotTimer = undefined;
			const { snapshots, journals } = readRunDirs();
			setSnapshotList(snapshots);
			setJournalList(journals);
		}, SNAPSHOT_DEBOUNCE_MS);
	}

	{
		const { snapshots, journals } = readRunDirs();
		setSnapshotList(snapshots);
		setJournalList(journals);
	}

	// -- S1: workflow tool calls ------------------------------------------------

	function ingest(ev: PartEvidence): void {
		const prev = partsByRun.get(ev.runId);
		if (prev && prev.updatedAt > ev.updatedAt) return;
		partsByRun.set(ev.runId, ev);
		setPartVersion(partVersion() + 1);
		if (ev.endedAt !== undefined) refreshRuns(); // settle may race the part
	}

	/** Filter + adopt a tool metadata record; ignores everything not ours. */
	function ingestMetadata(
		metadata: unknown,
		ctx: {
			sessionID: string;
			messageID: string;
			partID: string;
			updatedAt: number;
			endedAt?: number;
			partStatus?: string;
		},
	): void {
		if (typeof metadata !== "object" || metadata === null) return;
		const rec = metadata as { title?: string };
		const ev = extractPartEvidence(metadata, { ...ctx, title: rec.title });
		if (ev) ingest(ev);
	}

	const offProgress = context.data.on("session.tool.progress", (event) => {
		ingestMetadata(event.data.metadata, {
			sessionID: event.data.sessionID,
			messageID: event.data.assistantMessageID,
			partID: event.data.id,
			updatedAt: event.created,
		});
	});

	const offSuccess = context.data.on("session.tool.success", (event) => {
		ingestMetadata(event.data.metadata, {
			sessionID: event.data.sessionID,
			messageID: event.data.assistantMessageID,
			partID: event.data.id,
			updatedAt: event.created,
			endedAt: event.created,
			partStatus: "completed",
		});
	});

	const offFailed = context.data.on("session.tool.failed", (event) => {
		ingestMetadata((event.data as { metadata?: unknown }).metadata, {
			sessionID: event.data.sessionID,
			messageID: (event.data as { assistantMessageID?: string }).assistantMessageID ?? "",
			partID: (event.data as { id?: string }).id ?? "",
			updatedAt: event.created,
			endedAt: event.created,
			partStatus: "error",
		});
	});

	// -- S2: child-session map (live-run attribution + agent jump targets) -----

	const runParents = new Map<string, string>();
	const agentSessions = new Map<string, string>();
	// highest attempt seen per `${runId}:${agentId}` — retries jump to the newest session
	const agentAttempts = new Map<string, number>();

	function noteSession(info: unknown): void {
		const rec = info as {
			id?: string;
			sessionID?: string;
			parentID?: string;
			metadata?: Record<string, unknown>;
		} | null;
		if (!rec) return;
		const id = rec.id ?? rec.sessionID;
		if (typeof id !== "string") return;
		const meta = rec.metadata;
		const runId = meta?.runId;
		if (typeof runId !== "string" || !runId.startsWith("wf_")) return;
		let changed = false;
		if (typeof rec.parentID === "string" && runParents.get(runId) !== rec.parentID) {
			runParents.set(runId, rec.parentID);
			changed = true;
		}
		const agentId = meta?.agentId;
		if (typeof agentId === "string") {
			const key = `${runId}:${agentId}`;
			const attempt = typeof meta?.attempt === "number" && Number.isFinite(meta.attempt) ? meta.attempt : 0;
			if (attempt >= (agentAttempts.get(key) ?? -1) && agentSessions.get(key) !== id) {
				agentSessions.set(key, id);
				agentAttempts.set(key, attempt);
				changed = true;
			}
		}
		if (changed) setSessionVersion(sessionVersion() + 1);
	}

	// workflow child sessions carry {runId, agentId} metadata at create; new
	// sessions arrive as session.created, metadata refresh as
	// session.metadata.updated
	const offSessionCreated = context.data.on("session.created", (event) => noteSession(event.data));
	const offSessionMeta = context.data.on("session.metadata.updated", (event) => noteSession(event.data));

	const scannedSessions = new Set<string>();
	function scanSession(sessionID: string): void {
		if (scannedSessions.has(sessionID)) return;
		scannedSessions.add(sessionID);
		for (const message of context.data.session.message.list(sessionID)) {
			const content = (message as { content?: Array<Record<string, unknown>> }).content;
			if (!Array.isArray(content)) continue;
			const time = (message as { time?: { created?: number; completed?: number } }).time;
			for (const item of content) {
				ingestMetadata((item as { state?: { metadata?: unknown } }).state?.metadata, {
					sessionID,
					messageID: (message as { id?: string }).id ?? "",
					partID: (item as { id?: string }).id ?? "",
					updatedAt: time?.completed ?? time?.created ?? 0,
					// settled transcript — treat any recorded call as ended
					endedAt: time?.completed ?? time?.created ?? 0,
					partStatus: (item as { state?: { status?: string } }).state?.status,
				});
			}
		}
	}

	// -- assembly + heartbeat ---------------------------------------------------

	const runs = createMemo<RunView[]>(() => {
		partVersion();
		snapshotList();
		journalList();
		sessionVersion();
		// Track the heartbeat only while some run is live (a live journal or an
		// unsettled part): settled stores stop re-evaluating, so settled
		// dashboard views render once (and never re-mount mid-dialog — the route
		// tree tears down on every re-render).
		let anyLive = journalList().length > 0;
		if (!anyLive) {
			for (const part of partsByRun.values()) {
				if (part.endedAt === undefined) {
					anyLive = true;
					break;
				}
			}
		}
		const now = anyLive ? tickValue() : 0;
		return buildRuns({
			parts: [...partsByRun.values()],
			snapshots: snapshotList(),
			journals: journalList(),
			parents: runParents,
			agentSessions,
			now,
		});
	});

	function latestForSession(sessionID: string): RunView | undefined {
		return runs().find((run) => run.parentSessionID === sessionID);
	}

	// -- inline panel feed -------------------------------------------------------
	//
	// The composer-top slot re-renders on signal changes, so it reads only the
	// evidence version signals, and the coarse heartbeat ONLY while some run
	// is live — no workflows, no re-render churn at all.

	const coarseNow = createMemo(() => Math.floor(tickValue() / COARSE_MS) * COARSE_MS);

	const inlineRuns = createMemo<RunView[]>(() => {
		partVersion();
		snapshotList();
		journalList();
		sessionVersion();
		const anyLive = journalList().length > 0 || [...partsByRun.values()].some((part) => part.endedAt === undefined);
		const now = anyLive ? coarseNow() : 0;
		return buildRuns({
			parts: [...partsByRun.values()],
			snapshots: snapshotList(),
			journals: journalList(),
			parents: runParents,
			agentSessions,
			now,
		});
	});

	function inlineLatest(sessionID: string): RunView | undefined {
		return inlineRuns().find((run) => run.parentSessionID === sessionID && (run.live || run.stale));
	}

	const tickTimer = setInterval(() => {
		tickCount += 1;
		setTickValue(Date.now());
		// journals can appear (launch) and disappear (settle) at any time
		if (tickCount % REFRESH_EVERY_N_TICKS === 0) refreshRuns();
	}, 1000);
	tickTimer.unref?.();

	// -- control bridge ----------------------------------------------------------

	function control(runId: string, op: "kill" | "pause"): boolean {
		if (!/^wf_[a-z0-9-]{6,}$/.test(runId) || runId.includes("..") || runId.includes("/")) return false;
		try {
			// mirrors src/control.ts's ControlOp — the server validates strictly
			appendControlLine(
				runId,
				`${JSON.stringify({ v: 1, id: crypto.randomBytes(8).toString("hex"), runId, op, ts: Date.now(), source: "opencode-tui" })}\n`,
			);
			return true;
		} catch {
			return false;
		}
	}

	function dispose(): void {
		clearInterval(tickTimer);
		if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
		offProgress();
		offSuccess();
		offFailed();
		offSessionCreated();
		offSessionMeta();
	}

	return {
		runs,
		latestForSession,
		inlineLatest,
		coarseNow,
		tick: tickValue,
		refreshRuns,
		scanSession,
		control,
		dispose,
	};
}
