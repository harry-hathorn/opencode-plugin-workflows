/**
 * Inline workflow panel — the composer-adjacent status surface.
 *
 * While a run is live for the session, a one-line strip renders above the
 * composer (the "bullet"); activating it (↓ from an empty composer, <leader>w,
 * or the palette) highlights it, and enter expands a bordered, minimal-height
 * card: phases column left (❯ cursor), that phase's agents right. Everything
 * disappears when the run settles — history stays in the sidebar section and
 * the dashboard.
 *
 * The session_prompt slot is replace-mode: our renderer (index.tsx) re-renders
 * the stock composer via api.ui.Prompt inside its own column and mounts these
 * components above it. Like every slot renderer, live data resolves
 * synchronously in the renderer body — these components take plain values and
 * never read signals, and UI state lives in createInlineState() outside the
 * tree so it survives re-invocations (which re-mount the composer).
 */
/** @jsxImportSource @opentui/solid */

import type { Plugin } from "@opencode/plugin/tui";

type TuiContext = Plugin.Context;

import { createSignal, type JSX } from "solid-js";
import { type AgentRow, agentGlyph, fmtDuration, fmtTokens, type InlineView, type RunStatus, runGlyph } from "./data";
import { type ThemeColors, themeColors } from "./theme";

/** Max agent rows shown in the card's right column — the rest collapse into "+N more". */
export const INLINE_AGENT_WINDOW = 4;

export type InlineLevel = 0 | 1 | 2;

/** UI state that survives composer re-mounts (created once per plugin). */
export interface InlineState {
	/** 0 = inert strip, 1 = strip highlighted, 2 = expanded card */
	readonly level: () => InlineLevel;
	readonly setLevel: (level: InlineLevel) => void;
	/** session the panel state belongs to — pinning a different session resets */
	readonly sessionID: () => string | undefined;
	readonly pin: (sessionID: string) => void;
	readonly selectedPhase: () => number;
	readonly setSelectedPhase: (index: number) => void;
}

export function createInlineState(): InlineState {
	const [level, setLevel] = createSignal<InlineLevel>(0);
	const [sessionID, setSessionID] = createSignal<string | undefined>(undefined);
	const [selectedPhase, setSelectedPhase] = createSignal(0);
	return {
		level,
		setLevel,
		sessionID,
		pin(id: string) {
			if (sessionID() === id) return;
			setSessionID(id);
			setLevel(0);
			setSelectedPhase(0);
		},
		selectedPhase,
		setSelectedPhase,
	};
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

function agentColor(agent: AgentRow): "success" | "error" | "accent" | "textMuted" {
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
	return chips.length > 0 ? ` · ${chips.join(" · ")}` : "";
}

/** Right-column line: `label model · N tok · dur · chips` (model only when known). */
export function inlineAgentLine(agent: AgentRow): string {
	const lead = agent.model ? `${agent.label} ${agent.model}` : agent.label;
	const metrics = [
		agent.tokens !== undefined && agent.tokens > 0 ? `${fmtTokens(agent.tokens)} tok` : undefined,
		fmtDuration(agent.durationMs),
	].filter((part): part is string => part !== undefined);
	return `${lead}${metrics.length > 0 ? ` · ${metrics.join(" · ")}` : ""}${agentChips(agent)}`;
}

/** The inert/highlighted one-line strip — the "bullet" above the composer. */
export function InlineStrip(props: {
	context: TuiContext;
	view: InlineView;
	elapsed: string;
	active: boolean;
}): JSX.Element {
	const theme: ThemeColors = themeColors(props.context.theme);
	const { view } = props;
	const summary = `${view.done}/${view.agentCount} agents · ${fmtTokens(view.totalTokens)} tok · ${props.elapsed}${view.stale ? " · stale" : ""}`;
	return (
		<box flexDirection="column" flexShrink={0}>
			<box flexDirection="row" gap={1}>
				<text fg={theme[props.active ? "accent" : statusColor(view.status)]}>
					{props.active ? "❯" : runGlyph(view.status)}
				</text>
				<text fg={theme[props.active ? "text" : "textMuted"]}>{view.name}</text>
				<box flexGrow={1} />
				<text fg={theme.textMuted}>{summary}</text>
			</box>
			{props.active ? (
				<box flexDirection="row" gap={1} paddingLeft={2}>
					<text fg={theme.textMuted}>{"enter expand · x stop · p pause · esc back"}</text>
				</box>
			) : null}
		</box>
	);
}

/**
 * The expanded card: bordered, minimal height. Header (name, agents, tokens,
 * elapsed), then two columns — phases with the ❯ cursor left, the selected
 * phase's agents right, windowed to INLINE_AGENT_WINDOW rows.
 */
export function InlineCard(props: {
	context: TuiContext;
	view: InlineView;
	elapsed: string;
	selectedPhase: number;
}): JSX.Element {
	const theme: ThemeColors = themeColors(props.context.theme);
	const { view } = props;
	const phaseIdx = Math.min(props.selectedPhase, Math.max(0, view.phases.length - 1));
	const phase = view.phases[phaseIdx];
	const agents = phase?.agents ?? [];
	const windowed = agents.slice(0, INLINE_AGENT_WINDOW);
	const more = agents.length - windowed.length;

	return (
		<box flexShrink={0} border borderStyle="rounded" borderColor={theme.borderActive} flexDirection="column">
			<box flexDirection="row" gap={1}>
				<text fg={theme[statusColor(view.status)]}>{runGlyph(view.status)}</text>
				<text fg={theme.text}>{view.name}</text>
				<box flexGrow={1} />
				<text fg={theme.textMuted}>
					{`${view.done}/${view.agentCount} agents · ${fmtTokens(view.totalTokens)} tok · ${props.elapsed}${view.stale ? " · stale" : ""}`}
				</text>
			</box>
			<box flexDirection="row" gap={2}>
				<box flexDirection="column" width={24}>
					<text fg={theme.textMuted}>Phases</text>
					{view.phases.map((item, index) => (
						<box flexDirection="row" gap={1}>
							<text fg={theme.accent}>{index === phaseIdx ? "❯" : " "}</text>
							<text fg={index === phaseIdx ? theme.text : theme.textMuted}>
								{`${index + 1} ${item.title} ${item.done}/${item.total}`}
							</text>
						</box>
					))}
				</box>
				<box flexDirection="column" flexGrow={1}>
					<text fg={theme.text}>{`${phase?.title ?? "run"} · ${agents.length} agents`}</text>
					{windowed.map((agent) => (
						<box flexDirection="row" gap={1}>
							<text fg={theme[agentColor(agent)]}>{agentGlyph(agent)}</text>
							<text fg={theme.textMuted}>{inlineAgentLine(agent)}</text>
						</box>
					))}
					{more > 0 ? <text fg={theme.textMuted}>{`+${more} more`}</text> : null}
					{agents.length === 0 ? <text fg={theme.textMuted}>no agents yet</text> : null}
				</box>
			</box>
			<box flexDirection="row" gap={1}>
				<text fg={theme.textMuted}>{"j/k phase · enter full view · x kill · p pause · esc back"}</text>
			</box>
		</box>
	);
}
