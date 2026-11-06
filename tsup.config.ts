import { defineConfig } from "tsup";

// Two ESM bundles. The server entry stays self-contained (acorn bundled;
// @opencode/plugin is types-only at build time and resolved by the host at
// runtime). The tui entry must ship as precompiled ESM with its reactive
// imports EXTERNAL: the TUI host provides its own solid-js/@opentui/*
// instances when it loads plugin files, so a bundled copy would break.
export default defineConfig({
	entry: {
		index: "src/index.ts",
		tui: "src/tui/index.tsx",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "esnext",
	platform: "node",
	external: ["solid-js", "@opentui/core", "@opentui/solid", "@opencode/plugin"],
	esbuildOptions(options) {
		options.jsx = "automatic";
		options.jsxImportSource = "@opentui/solid";
	},
});
