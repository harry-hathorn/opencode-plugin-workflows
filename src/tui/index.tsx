/**
 * The TUI half of the plugin, OpenCode V2 plugin API. The TUI process loads
 * this module through the package's "./tui" export; register the package once
 * in the `plugins` array of opencode.json(c) — the TUI part of a server-loaded
 * package loads automatically (cli.json `plugins` is for TUI-only packages).
 *
 * Rendering goes through opencode V2's plugin surfaces: a sidebar.content
 * slot contribution, a full-screen dashboard route (ui.router), and the inline
 * panel above the session composer (session.composer.top slot — appended, not
 * replacing the composer; V2 has no replace-mode composer slot). The reactive
 * imports (solid-js, @opentui/*) stay external on purpose — the host provides
 * its own instances.
 *
 * Slot renderers resolve store data synchronously in the renderer body — the
 * host re-invokes a renderer when the signals it read change. Reading
 * `store.tick()` keeps the sidebar on the 1s heartbeat; the composer-top
 * renderer instead reads the store's evidence-frequency feed (inlineLatest +
 * coarseNow) to keep re-render churn away from the composer.
 */
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createDashboardState, Dashboard, type DashboardParams, resolveDashboardData } from "./dashboard";
import { buildInlineView, fmtDuration, type RunView } from "./data";
import { createDialogTracker } from "./dialogs";
import { createInlineState, InlineCard, InlineStrip } from "./inline";
import { WorkflowsSection } from "./sidebar";
import { createWorkflowStore } from "./store";

export const ROUTE = "workflows.dashboard";

export default Plugin.define({
	id: "opencode-plugin-workflows",
	setup(context) {
		const store = createWorkflowStore(context);
		const dashboardState = createDashboardState();
		const inlineState = createInlineState();
		const dialogs = createDialogTracker();

		const openDashboard = (sessionID?: string) => {
			context.ui.router.navigate({ type: "plugin", name: ROUTE, data: { sessionID } });
		};

		const sessionRouteID = (): string | undefined => {
			const current = context.ui.router.current();
			return current.type === "session" ? current.sessionID : undefined;
		};

		/** the run the inline panel is currently speaking about, if any */
		const panelRun = (): RunView | undefined => {
			const sid = inlineState.sessionID() ?? sessionRouteID();
			return sid ? store.inlineLatest(sid) : undefined;
		};

		const confirmControl = async (op: "kill" | "pause"): Promise<void> => {
			const run = panelRun();
			if (!run?.live) return;
			const ok = await dialogs.run(() =>
				context.ui.dialog.confirm({
					title: op === "kill" ? "Kill workflow" : "Pause workflow",
					message: `${run.name} [${run.runId}]`,
					label: { confirm: op === "kill" ? "Kill" : "Pause" },
				}),
			);
			if (ok === true) store.control(run.runId, op);
		};

		const movePhase = (delta: number): void => {
			if (inlineState.level() !== 2) return; // j/k are inert on the strip
			const run = panelRun();
			if (!run) return;
			const phases = buildInlineView(run).phases;
			if (phases.length === 0) return;
			const max = phases.length - 1;
			inlineState.setSelectedPhase(Math.max(0, Math.min(inlineState.selectedPhase() + delta, max)));
		};

		// -- sidebar section (between LSP and Todo in the V2 contribution order)
		context.ui.slot({
			append: "sidebar.content",
			render: ({ sessionID }) => {
				// seed parts for workflows this session ran before the TUI started
				// (idempotent — one scan per sessionID)
				store.scanSession(sessionID);
				const now = store.tick();
				const run = store.latestForSession(sessionID);
				const recent = store
					.runs()
					.filter((item) => item.parentSessionID === sessionID && item.runId !== run?.runId && !item.live)
					.slice(0, 2);
				return (
					<WorkflowsSection
						context={context}
						run={run}
						recent={recent}
						now={now}
						onOpen={() => openDashboard(sessionID)}
					/>
				);
			},
		});

		// -- inline panel above the composer. Reads are evidence-frequency ONLY
		// (inlineLatest/coarseNow) so per-second churn never re-renders the
		// composer area while the user types.
		context.ui.slot({
			append: "session.composer.top",
			render: ({ sessionID }) => {
				store.scanSession(sessionID);
				inlineState.pin(sessionID);
				const run = store.inlineLatest(sessionID);
				if (!run && inlineState.level() !== 0) inlineState.setLevel(0); // settled → vanish
				const level = run ? inlineState.level() : 0;
				// conditional read — the coarse heartbeat is only a dependency
				// while a run is live (same discipline as the store's runs memo)
				const elapsed = run ? fmtElapsedRun(run, store.coarseNow()) : "";
				return (
					<box flexDirection="column">
						{run && level === 2 ? (
							<InlineCard
								context={context}
								view={buildInlineView(run)}
								elapsed={elapsed}
								selectedPhase={inlineState.selectedPhase()}
							/>
						) : run ? (
							<InlineStrip
								context={context}
								view={buildInlineView(run)}
								elapsed={elapsed}
								active={level === 1}
							/>
						) : null}
					</box>
				);
			},
		});

		// -- dashboard route
		context.ui.router.register({
			name: ROUTE,
			// Resolve all live data synchronously here — the host re-invokes this
			// render function when these reads change (route trees freeze
			// internal reactivity, same as slot subtrees).
			render: ({ data }) => {
				const params = (data ?? {}) as DashboardParams;
				const view = resolveDashboardData(store, params, dashboardState);
				return (
					<Dashboard
						context={context}
						store={store}
						state={dashboardState}
						params={params}
						data={view}
						routeName={ROUTE}
					/>
				);
			},
		});

		// -- inline panel keys, both levels. Priority 1000 is the host's overlay
		// tier — above the composer's input layer, so j/k reach the panel while
		// the composer keeps focus. Quiet while a dialog is open (modal
		// pattern) or off the session route.
		context.keymap.layer(() => ({
			mode: "global",
			priority: 1000,
			enabled: () => inlineState.level() >= 1 && context.ui.router.current().type === "session" && !dialogs.open(),
			commands: [
				{
					id: "workflows.phase.next",
					title: "Workflows: next phase",
					bind: "j,down",
					run: () => movePhase(1),
				},
				{
					id: "workflows.phase.prev",
					title: "Workflows: previous phase",
					bind: "k,up",
					run: () => movePhase(-1),
				},
				{
					id: "workflows.phase.first",
					title: "Workflows: first phase",
					bind: "g",
					run: () => inlineState.setSelectedPhase(0),
				},
				{
					id: "workflows.phase.last",
					title: "Workflows: last phase",
					bind: "shift+g",
					run: () => {
						const run = panelRun();
						const phases = run ? buildInlineView(run).phases : [];
						inlineState.setSelectedPhase(Math.max(0, phases.length - 1));
					},
				},
				{
					id: "workflows.panel.expand",
					title: "Workflows: expand panel / full view",
					bind: "return",
					run: () => {
						if (inlineState.level() === 1) {
							inlineState.setLevel(2);
							return;
						}
						openDashboard(inlineState.sessionID());
					},
				},
				{
					id: "workflows.panel.kill",
					title: "Workflows: kill workflow",
					bind: "x",
					run: () => void confirmControl("kill"),
				},
				{
					id: "workflows.panel.pause",
					title: "Workflows: pause workflow",
					bind: "p",
					run: () => void confirmControl("pause"),
				},
				{
					id: "workflows.panel.back",
					title: "Workflows: back",
					bind: "escape,left,q",
					run: () => inlineState.setLevel(inlineState.level() === 2 ? 1 : 0),
				},
			],
		}));

		// -- the discoverable entries: palette commands + <leader>d.
		// (V1's ↓ from an empty composer relied on composer-input access the
		// V2 API does not expose — the leader key and palette are the entry.)
		context.keymap.layer(() => ({
			mode: "global",
			commands: [
				{
					id: "workflows.open",
					title: "Workflows: dashboard",
					group: "Workflows",
					palette: true,
					slash: { name: "wf-dashboard", aliases: ["workflows"] },
					run() {
						openDashboard(sessionRouteID());
						context.ui.dialog.clear();
					},
				},
				{
					id: "workflows.panel",
					title: "Workflows: status panel",
					group: "Workflows",
					palette: true,
					bind: "<leader>d",
					run() {
						const sessionID = sessionRouteID();
						if (sessionID && store.inlineLatest(sessionID)) {
							inlineState.setLevel(1);
							context.ui.dialog.clear();
							return;
						}
						// nothing live — the dashboard is the useful surface instead of a no-op
						openDashboard(sessionID);
						context.ui.dialog.clear();
					},
				},
			],
			bindings: ["workflows.panel"],
		}));

		return () => store.dispose();
	},
});

/** Elapsed for a run at coarse granularity — settled runs use their duration. */
function fmtElapsedRun(run: RunView, now: number): string {
	// clamp: the coarse clock floors to 30s, so a run launched just after a
	// boundary can read as negative until the next tick catches up
	const ms = run.durationMs ?? (run.startedAt !== undefined ? Math.max(0, now - run.startedAt) : undefined);
	return ms === undefined ? "" : fmtDuration(ms);
}
