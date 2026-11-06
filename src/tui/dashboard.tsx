/**
 * Full-screen dashboard route: phase→agent tree for a run with live status,
 * a run switcher, filters, narrator logs, jump-to-agent-session, and
 * pause/kill control. Opened from the sidebar section (click), the palette,
 * or <leader>d.
 *
 * Plugin route trees freeze fine-grained reactivity exactly like slot
 * subtrees — the host only re-invokes the route's render function. So the
 * render function in index.tsx calls resolveDashboardData() (which reads the
 * store and the state signals synchronously) and passes plain values; any of
 * those reads changing re-renders the whole view. UI state (selection,
 * filter, logs, scroll) lives in createDashboardState() OUTSIDE the component
 * so it survives those re-renders. The heartbeat is only read while the
 * displayed run is live, so settled views render once and keep their scroll
 * position.
 */
/** @jsxImportSource @opentui/solid */

import type { Plugin } from "@opencode/plugin/tui";

type TuiContext = Plugin.Context;

import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createSignal, type JSX, onCleanup, onMount } from "solid-js";
import {
	type AgentRow,
	agentGlyph,
	type DashboardFilter,
	doneCount,
	type FlatAgentRow,
	type FlatRow,
	flattenRun,
	fmtDuration,
	fmtTokens,
	type RunView,
	runGlyph,
} from "./data";
import { createDialogTracker, type DialogTracker } from "./dialogs";
import type { WorkflowStore } from "./store";
import { type ThemeColors, themeColors } from "./theme";

export interface DashboardParams {
	sessionID?: string;
}

/** UI state that survives whole-view re-renders (created once per plugin). */
export interface DashboardState {
	readonly selectedRunId: () => string | undefined;
	readonly setSelectedRunId: (id: string | undefined) => void;
	readonly selectedIdx: () => number;
	readonly setSelectedIdx: (idx: number) => void;
	readonly filter: () => DashboardFilter;
	readonly setFilter: (filter: DashboardFilter) => void;
	readonly showLogs: () => boolean;
	readonly setShowLogs: (value: boolean) => void;
	/** transient status line (plugin routes have no host toast overlay) */
	readonly flash: () => string | undefined;
	readonly setFlash: (message: string) => void;
	/** scroll position restored across re-renders */
	savedScrollTop: number;
}

const FLASH_MS = 2500;

export function createDashboardState(): DashboardState {
	const [selectedRunId, setSelectedRunId] = createSignal<string | undefined>(undefined);
	const [selectedIdx, setSelectedIdx] = createSignal(0);
	const [filter, setFilter] = createSignal<DashboardFilter>("all");
	const [showLogs, setShowLogs] = createSignal(false);
	const [flash, setFlashSignal] = createSignal<string | undefined>(undefined);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	const setFlash = (message: string) => {
		setFlashSignal(message);
		if (flashTimer !== undefined) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => setFlashSignal(undefined), FLASH_MS);
		flashTimer.unref?.();
	};
	return {
		selectedRunId,
		setSelectedRunId,
		selectedIdx,
		setSelectedIdx,
		filter,
		setFilter,
		showLogs,
		setShowLogs,
		flash,
		setFlash,
		savedScrollTop: 0,
	};
}

/** Everything the view needs, resolved synchronously (re-render on change). */
export interface DashboardData {
	run: RunView | undefined;
	rows: FlatRow[];
	/** flat indexes of selectable rows (agents) */
	selectable: number[];
	/** flat index of the selected agent row, -1 when none */
	selectedRowIdx: number;
	selected: FlatAgentRow | undefined;
	elapsed: string;
	done: number;
	/** transient status line, read here so a flash re-renders the view */
	flash: string | undefined;
}

export function resolveDashboardData(
	store: WorkflowStore,
	params: DashboardParams,
	state: DashboardState,
): DashboardData {
	const all = store.runs();
	const id = state.selectedRunId();
	let run = id ? all.find((item) => item.runId === id) : undefined;
	if (!run && params.sessionID) {
		run = all.find((item) => item.parentSessionID === params.sessionID);
	}
	if (!run) run = all[0];

	// tracked heartbeat only while the view is live — settled views render once
	const now = run?.live ? store.tick() : 0;
	const rows = run ? flattenRun(run, { filter: state.filter(), showLogs: state.showLogs() }) : [];
	const selectable = rows.flatMap((row, i) => (row.kind === "agent" ? [i] : []));
	const idx = Math.min(state.selectedIdx(), Math.max(0, selectable.length - 1));
	const selectedRowIdx = selectable.length > 0 ? selectable[idx] : -1;
	const selectedRow = selectedRowIdx >= 0 ? rows[selectedRowIdx] : undefined;
	const selected = selectedRow && selectedRow.kind === "agent" ? selectedRow : undefined;
	return {
		run,
		rows,
		selectable,
		selectedRowIdx,
		selected,
		elapsed: fmtDuration(run?.durationMs ?? (run?.live ? now - (run.startedAt ?? 0) : undefined)),
		done: run ? doneCount(run) : 0,
		flash: state.flash(),
	};
}

const FILTERS: DashboardFilter[] = ["all", "running", "done", "error"];

type ThemeColor = "success" | "error" | "warning" | "accent" | "textMuted" | "text";

function statusColor(status: RunView["status"]): ThemeColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "killed":
		case "paused":
			return "warning";
		case "running":
			return "accent";
		case "unknown":
			return "textMuted";
	}
}

function agentColor(agent: AgentRow): ThemeColor {
	if (agent.state === "error") return "error";
	if (agent.state === "done") return "success";
	if (agent.state === "progress") return "accent";
	return "textMuted";
}

function agentChips(agent: AgentRow): string {
	const chips: string[] = [];
	if (agent.attempt !== undefined && agent.attempt > 1) chips.push(`try ${agent.attempt}`);
	if (agent.cached) chips.push("cached");
	if (agent.skipped) chips.push("skipped");
	if (agent.blocked) chips.push("blocked");
	return chips.length > 0 ? ` · ${chips.join(" · ")}` : "";
}

function agentLine(agent: AgentRow): string {
	const parts = [agent.label];
	if (agent.model) parts.push(agent.model);
	const metrics = [
		agent.tokens !== undefined ? `${fmtTokens(agent.tokens)} tok` : undefined,
		fmtDuration(agent.durationMs),
	].filter((part): part is string => part !== undefined);
	return `${parts.join(" ")}${metrics.length > 0 ? ` · ${metrics.join(" · ")}` : ""}${agentChips(agent)}`;
}

export function Dashboard(props: {
	context: TuiContext;
	store: WorkflowStore;
	state: DashboardState;
	params: DashboardParams;
	data: DashboardData;
	/** own route name (index.tsx ROUTE) — distinguishes re-render from route exit */
	routeName: string;
}): JSX.Element {
	const theme: ThemeColors = themeColors(props.context.theme);
	const dialogs: DialogTracker = createDialogTracker();
	const { data, state } = props;
	const run = data.run;

	// -- body scroll: preserved across re-renders, anchored to selection -------

	let scroll: ScrollBoxRenderable | undefined;
	const agentNodes = new Map<number, BoxRenderable>();

	function anchorSelection(): void {
		const rowIdx = data.selectedRowIdx;
		if (rowIdx < 0 || !scroll) return;
		const node = agentNodes.get(rowIdx);
		if (!node) return;
		const contentY = scroll.scrollTop + (node.y - scroll.viewport.y);
		scroll.scrollTop = Math.max(0, contentY - 2);
	}

	onMount(() => {
		if (scroll && state.savedScrollTop > 0) scroll.scrollTop = state.savedScrollTop;
		queueMicrotask(anchorSelection);
	});
	onCleanup(() => {
		state.savedScrollTop = scroll?.scrollTop ?? 0;
	});

	// -- actions ---------------------------------------------------------------

	function move(delta: number): void {
		const max = data.selectable.length - 1;
		if (max < 0) return;
		state.setSelectedIdx(Math.max(0, Math.min(state.selectedIdx() + delta, max)));
	}

	function close(): void {
		if (dialogs.open()) return; // a dialog consumes the key first
		props.context.ui.dialog.clear();
		const back = props.params.sessionID;
		if (back) props.context.ui.router.navigate({ type: "session", sessionID: back });
		else props.context.ui.router.navigate({ type: "home" });
	}

	function openAgent(): void {
		const agent = data.selected?.agent;
		if (!agent) return;
		if (!agent.sessionId) {
			state.setFlash(`No session yet for ${agent.label}`);
			return;
		}
		props.context.ui.router.navigate({ type: "session", sessionID: agent.sessionId });
	}

	async function openRunSwitcher(): Promise<void> {
		const all = props.store.runs();
		if (all.length === 0) {
			state.setFlash("No runs yet");
			return;
		}
		const now = props.store.tick();
		const options = all.map((item) => ({
			title: `${runGlyph(item.status)} ${item.name} ${item.runId.slice(0, 13)}`,
			value: item.runId,
			description: `${item.status}${item.live ? " · live" : ""}${item.stale ? " · stale" : ""} · ${doneCount(item)}/${item.agentCount} agents · ${fmtTokens(item.totalTokens)} tok · ${fmtDuration(item.durationMs ?? now - (item.startedAt ?? 0))}`,
		}));
		const picked = await dialogs.run(() =>
			props.context.ui.dialog.select({
				title: "Switch run",
				current: run?.runId,
				options,
			}),
		);
		if (picked !== undefined) {
			state.setSelectedRunId(picked as string);
			state.setSelectedIdx(0);
			state.savedScrollTop = 0;
		}
	}

	function cycleFilter(): void {
		const next = FILTERS[(FILTERS.indexOf(state.filter()) + 1) % FILTERS.length];
		state.setFilter(next);
		state.setSelectedIdx(0);
	}

	async function confirmControl(op: "kill" | "pause"): Promise<void> {
		if (!run) return;
		if (!run.live) {
			state.setFlash(`${run.name} already settled (${run.status})`);
			return;
		}
		const ok = await dialogs.run(() =>
			props.context.ui.dialog.confirm({
				title: op === "kill" ? "Kill run" : "Pause run",
				message: `${run.name} [${run.runId}]`,
				label: { confirm: op === "kill" ? "Kill" : "Pause" },
			}),
		);
		if (ok === true) {
			const sent = props.store.control(run.runId, op);
			state.setFlash(sent ? `${op} sent — ${run.runId.slice(0, 13)}` : `Failed to write ${op} op`);
		}
	}

	function openHelp(): void {
		const entries: Array<[string, string]> = [
			["j / k, ↓ / ↑", "move selection"],
			["g / G", "first / last agent"],
			["return", "open the agent's session"],
			["r", "switch run"],
			["f", "cycle filter (all → running → done → error)"],
			["l", "toggle narrator log lines"],
			["p", "pause the run"],
			["x", "kill the run"],
			["q / esc", "close the dashboard"],
		];
		props.context.ui.dialog.show(
			() => (
				<box flexDirection="column" gap={0} paddingTop={1} paddingLeft={1}>
					<text fg={theme.accent}>Workflows dashboard</text>
					{entries.map(([keys, desc]) => (
						<box flexDirection="row" gap={1}>
							<text fg={theme.text}>{keys}</text>
							<text fg={theme.textMuted}>{desc}</text>
						</box>
					))}
				</box>
			),
			() => {
				dialogs.end();
				props.context.ui.dialog.clear();
			},
		);
		dialogs.begin();
		props.context.ui.dialog.set({ size: "large" });
	}

	// -- mount-scoped keys -------------------------------------------------------

	props.context.keymap.layer(() => ({
		// above app/session-level bindings so route keys (x, ?, return) win while
		// the dashboard is mounted; below system intercepts (which-key 900).
		// Uppercase letters arrive as shift+<lowercase>, so G binds as shift+g.
		// While a dialog is open the layer goes quiet so the dialog's own
		// escape/ctrl+c bindings close it (modal pattern).
		mode: "global",
		priority: 100,
		enabled: () => !dialogs.open(),
		commands: [
			{ id: "workflows.dashboard.next", title: "Workflows: next agent", bind: "j,down", run: () => move(1) },
			{ id: "workflows.dashboard.prev", title: "Workflows: previous agent", bind: "k,up", run: () => move(-1) },
			{
				id: "workflows.dashboard.first",
				title: "Workflows: first agent",
				bind: "g",
				run: () => state.setSelectedIdx(0),
			},
			{
				id: "workflows.dashboard.last",
				title: "Workflows: last agent",
				bind: "shift+g",
				run: () => state.setSelectedIdx(Math.max(0, data.selectable.length - 1)),
			},
			{
				id: "workflows.dashboard.openAgent",
				title: "Workflows: open agent session",
				bind: "return",
				run: () => openAgent(),
			},
			{
				id: "workflows.dashboard.switch",
				title: "Workflows: switch run",
				bind: "r",
				run: () => void openRunSwitcher(),
			},
			{ id: "workflows.dashboard.filter", title: "Workflows: cycle filter", bind: "f", run: () => cycleFilter() },
			{
				id: "workflows.dashboard.logs",
				title: "Workflows: toggle logs",
				bind: "l",
				run: () => state.setShowLogs(!state.showLogs()),
			},
			{
				id: "workflows.dashboard.pause",
				title: "Workflows: pause run",
				bind: "p",
				run: () => void confirmControl("pause"),
			},
			{
				id: "workflows.dashboard.kill",
				title: "Workflows: kill run",
				bind: "x",
				run: () => void confirmControl("kill"),
			},
			{ id: "workflows.dashboard.help", title: "Workflows: help", bind: "?,shift+/", run: () => openHelp() },
			{ id: "workflows.dashboard.close", title: "Workflows: close dashboard", bind: "q,escape", run: () => close() },
		],
	}));
	onCleanup(() => {
		// Re-renders (selection, filter, flash, live tick) re-mount this
		// component and must NOT close an open dialog — only a real route
		// exit (route.current already moved off our route) should.
		if (props.context.ui.router.current().type !== "plugin") props.context.ui.dialog.clear();
	});

	// -- render ------------------------------------------------------------------

	return (
		<box
			style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
			backgroundColor={theme.background}
			flexDirection="column"
		>
			{run ? (
				<box flexDirection="row" paddingLeft={1} flexShrink={0}>
					<text fg={theme[statusColor(run.status)]}>{runGlyph(run.status)}</text>
					<text fg={theme.text}>{` ${run.name} [${run.runId.slice(0, 13)}]`}</text>
					{run.nested ? <text fg={theme.accent}>{` ▸ ${run.workflowName ?? "nested"}`}</text> : null}
					<box flexGrow={1} />
					<text fg={theme.textMuted}>{`${data.done}/${run.agentCount} agents`}</text>
				</box>
			) : (
				<box paddingLeft={1} flexShrink={0}>
					<text fg={theme.textMuted}>No workflow runs yet</text>
				</box>
			)}
			{run ? (
				<box flexDirection="row" paddingLeft={1} flexShrink={0}>
					<text fg={theme.textMuted}>
						{`${run.status} · ${fmtTokens(run.totalTokens)} tok · ${data.elapsed} · filter:${state.filter()}${state.showLogs() ? " · logs" : ""}${run.stale ? " · stale" : ""}`}
					</text>
				</box>
			) : null}
			<box flexGrow={1} minHeight={0}>
				<scrollbox
					ref={(element: ScrollBoxRenderable) => {
						scroll = element;
					}}
					flexGrow={1}
					verticalScrollbarOptions={{ visible: true }}
				>
					<box flexDirection="column" paddingLeft={1}>
						{data.rows.map((row, index) => {
							if (row.kind === "phase") {
								return <text fg={theme.textMuted}>{`▸ ${row.phase.title} (${row.visible}/${row.total})`}</text>;
							}
							if (row.kind === "log") {
								return <text fg={theme.textMuted}>{`│ ${row.message}`}</text>;
							}
							const isSelected = index === data.selectedRowIdx;
							return (
								<box
									ref={(element: BoxRenderable) => {
										agentNodes.set(index, element);
									}}
									flexDirection="row"
									gap={1}
								>
									<text fg={isSelected ? theme.accent : theme.background}>{isSelected ? "›" : " "}</text>
									<text fg={theme[agentColor(row.agent)]}>{agentGlyph(row.agent)}</text>
									<text fg={isSelected ? theme.text : theme.textMuted}>{agentLine(row.agent)}</text>
								</box>
							);
						})}
						{data.rows.length === 0 && run ? (
							<text fg={theme.textMuted}>{`no agents match filter:${state.filter()} — f cycles`}</text>
						) : null}
						{run?.error ? (
							<box flexDirection="column" paddingTop={1}>
								<text fg={theme.error}>{`error: ${run.error}`}</text>
							</box>
						) : null}
					</box>
				</scrollbox>
			</box>
			{data.flash ? (
				<box paddingLeft={1} flexShrink={0}>
					<text fg={theme.accent}>{`— ${data.flash}`}</text>
				</box>
			) : null}
			<box flexDirection="row" paddingLeft={1}>
				<text fg={theme.textMuted}>
					{"j/k select · return open · r runs · f filter · l logs · p pause · x kill · ? help · q close"}
				</text>
				<box flexGrow={1} />
				<text
					fg={theme.textMuted}
				>{`${fmtTokens(run?.totalTokens)} tok · ${run?.totalToolCalls ?? 0} tool calls`}</text>
			</box>
		</box>
	);
}
