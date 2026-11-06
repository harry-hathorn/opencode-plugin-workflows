/**
 * V2 theme adapter. OpenCode V2 exposes a structured ResolvedTheme
 * (text.base, text.feedback.success.base, …); the workflow views were written
 * against the V1 flat token set. This maps the handful of tokens they use,
 * preserving the host's exact color types.
 */
import type { ResolvedTheme } from "@opencode/theme/tui";

export type ThemeColors = {
	text: ResolvedTheme["text"]["base"];
	textMuted: ResolvedTheme["text"]["muted"];
	success: ResolvedTheme["text"]["feedback"]["success"]["base"];
	error: ResolvedTheme["text"]["feedback"]["error"]["base"];
	warning: ResolvedTheme["text"]["feedback"]["warning"]["base"];
	accent: ResolvedTheme["text"]["action"]["primary"]["base"];
	background: ResolvedTheme["background"]["base"];
	borderActive: ResolvedTheme["border"]["base"];
};

export function themeColors(theme: ResolvedTheme): ThemeColors {
	return {
		text: theme.text.base,
		textMuted: theme.text.muted,
		success: theme.text.feedback.success.base,
		error: theme.text.feedback.error.base,
		warning: theme.text.feedback.warning.base,
		accent: theme.text.action.primary.base,
		background: theme.background.base,
		borderActive: theme.border.base,
	};
}
