/**
 * Sidebar section (order 350, between LSP and Todo): the session's newest run
 * with a live summary plus up to two recent settled lines. Display + mouse
 * only — the whole block opens the dashboard on click. Hidden when the session
 * has no workflow evidence.
 *
 * Plain presentational component: the slot renderer in index.tsx resolves
 * run/recent/now synchronously so the host re-invokes it on every store change
 * (the slot system re-renders renderers whose synchronous reads changed —
 * fine-grained reactivity inside a returned subtree does not update).
 */
/** @jsxImportSource @opentui/solid */

import type { Plugin } from "@opencode/plugin/tui";

type TuiContext = Plugin.Context;

import type { JSX } from "solid-js";
import { type AgentRow, doneCount, fmtDuration, fmtTokens, type RunStatus, type RunView, runGlyph } from "./data";
import { type ThemeColors, themeColors } from "./theme";

/** Sidebar width is 42 — clip labels to keep single-line rows. */
function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function statusColor(status: RunStatus): "success" | "error" | "warning" | "accent" | "textMuted" {
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

/** The phase currently in flight: last phase whose agents aren't all done. */
function currentPhase(run: RunView): string | undefined {
	const phases = run.rows.filter((row) => row.type === "workflow_phase");
	for (let i = phases.length - 1; i >= 0; i--) {
		const phase = phases[i];
		if (phase.type !== "workflow_phase") continue;
		const agents = run.rows.filter(
			(row): row is AgentRow => row.type === "workflow_agent" && row.phaseIndex === phase.index,
		);
		if (!agents.every((a) => a.state === "done" || a.cached || a.skipped)) return phase.title;
	}
	return undefined;
}

export function WorkflowsSection(props: {
	context: TuiContext;
	run: RunView | undefined;
	recent: RunView[];
	/** epoch ms — the store tick that triggered this render (elapsed/stale) */
	now: number;
	onOpen: () => void;
}): JSX.Element {
	const theme: ThemeColors = themeColors(props.context.theme);
	const current = props.run;
	const elapsed = current
		? fmtDuration(current.durationMs !== undefined ? current.durationMs : props.now - (current.startedAt ?? 0))
		: "";
	const phase = current && !current.nested ? currentPhase(current) : undefined;

	return (
		<box>
			{current ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: sidebar slots are display + mouse only (host contract — no roles)
				<box onMouseDown={() => props.onOpen()}>
					<box flexDirection="row" gap={1}>
						<text fg={theme[statusColor(current.status)]}>{runGlyph(current.status)}</text>
						<text fg={theme.text}>{clip(`${current.name} [${current.runId}]`, 38)}</text>
					</box>
					<text fg={theme.textMuted}>
						{clip(
							`  ${doneCount(current)}/${current.agentCount} agents · ${fmtTokens(current.totalTokens)} tok · ${elapsed}${phase ? ` · ${phase}` : ""}${current.stale ? " · stale" : ""}`,
							40,
						)}
					</text>
					{current.nested ? (
						<text fg={theme.accent}>{`  ▸ ${clip(current.workflowName ?? "nested", 36)}`}</text>
					) : null}
				</box>
			) : null}
			{props.recent.map((item) => (
				<text fg={theme.textMuted}>
					{clip(
						`${runGlyph(item.status)} ${item.name} · ${item.agentCount} agents · ${fmtDuration(item.durationMs)}`,
						40,
					)}
				</text>
			))}
		</box>
	);
}
