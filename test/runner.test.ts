import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileWorkflow } from "../src/compile";
import { Journal, type JournalRow, newRunId, runsRoot } from "../src/journal";
import { agentCapError } from "../src/prompts";
import {
	type AgentFn,
	createSharedRunState,
	executeWorkflow,
	MAX_ITEMS_PER_CALL,
	type RunOutcome,
	type SharedRunState,
	WorkflowAgentCapError,
} from "../src/runner";

const META = `export const meta = { name: 't', description: 'test workflow', phases: [{ title: 'One' }] }\n`;

let tmp: string;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runner-"));
	process.env.XDG_DATA_HOME = tmp;
});

interface RunOpts {
	agent?: AgentFn;
	resume?: { results: Map<string, unknown>; rows: JournalRow[] };
	signal?: AbortSignal;
	budgetTotal?: number | null;
	maxAgents?: number;
}

async function run(source: string, opts: RunOpts = {}): Promise<{ outcome: RunOutcome; journalFile: string }> {
	const compiled = compileWorkflow(source);
	const runId = newRunId();
	const journalFile = path.join(runsRoot(), runId, "journal.jsonl");
	const outcome = await executeWorkflow({
		runId,
		compiled,
		args: undefined,
		agent: opts.agent ?? echoAgent,
		journal: new Journal(journalFile),
		resume: opts.resume,
		signal: opts.signal,
		budgetTotal: opts.budgetTotal ?? null,
		maxAgents: opts.maxAgents,
	});
	return { outcome, journalFile };
}

const echoAgent: AgentFn = async (prompt) => ({ value: `ok:${prompt}` });

function recordingAgent(log: string[], handler?: AgentFn): AgentFn {
	return async (prompt, opts, call) => {
		log.push(prompt);
		if (handler) return handler(prompt, opts, call);
		return { value: `ok:${prompt}` };
	};
}

describe("basic execution", () => {
	test("runs a trivial script to completion", async () => {
		const { outcome } = await run(`${META}return 42`);
		expect(outcome.status).toBe("completed");
		expect(outcome.result).toBe(42);
		expect(outcome.progress.agentCount).toBe(0);
	});

	test("function results are refused", async () => {
		const { outcome } = await run(`${META}return () => 1`);
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("cannot be a function");
	});

	test("phases are seeded from meta and phase() groups agents", async () => {
		const { outcome } = await run(`${META}phase('Two')\nconst a = await agent('x', { phase: 'Two' })\nreturn a`);
		const titles = outcome.progress.rows.filter((r) => r.type === "workflow_phase").map((r) => r.title);
		expect(titles).toEqual(["One", "Two"]);
	});

	test("log() rows surface in progress", async () => {
		const { outcome } = await run(`${META}log('hello')\nreturn 1`);
		expect(outcome.progress.rows.some((r) => r.type === "workflow_log" && r.message === "hello")).toBe(true);
	});
});

describe("parallel semantics", () => {
	test("returns all values in order", async () => {
		const { outcome } = await run(`${META}return await parallel([() => agent('a'), () => agent('b')])`);
		expect(outcome.status).toBe("completed");
		expect(outcome.result).toEqual(["ok:a", "ok:b"]);
	});

	test("agent terminal failures become null slots", async () => {
		const agent: AgentFn = async (prompt) => (prompt === "bad" ? null : { value: `ok:${prompt}` });
		const { outcome } = await run(`${META}return await parallel([() => agent('good'), () => agent('bad')])`, {
			agent,
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.result).toEqual(["ok:good", null]);
		expect(outcome.progress.rows.some((r) => r.type === "workflow_agent" && r.state === "error")).toBe(true);
	});

	test("passing promises instead of thunks throws the canonical TypeError", async () => {
		const { outcome } = await run(`${META}return await parallel([agent('a')])`);
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain(
			"parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
		);
	});

	test("item cap is enforced per call", async () => {
		const { outcome } = await run(
			`${META}const items = Array.from({ length: ${MAX_ITEMS_PER_CALL + 1} }, (_, i) => i)\nreturn await parallel(items.map(i => () => i))`,
		);
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain(`at most ${MAX_ITEMS_PER_CALL} items`);
	});
});

describe("pipeline semantics", () => {
	test("stages receive (prevResult, originalItem, index)", async () => {
		const { outcome } = await run(
			`${META}
      return await pipeline(
        ['a', 'b'],
        (p, item, i) => \`\${p}:\${i}\`,
        (p) => p.toUpperCase(),
      )`,
		);
		expect(outcome.result).toEqual(["A:0", "B:1"]);
	});

	test("a throwing stage drops the item to null and skips its remaining stages", async () => {
		const { outcome } = await run(
			`${META}
      const calls = []
      const out = await pipeline(
        ['keep', 'drop'],
        (p) => { if (p === 'drop') throw new Error('boom'); return p },
        (p) => { calls.push(p); return p + '!' },
      )
      return { out, calls }`,
		);
		expect(outcome.result).toEqual({ out: ["keep!", null], calls: ["keep"] });
		expect(outcome.failures.some((f) => f.includes("boom"))).toBe(true);
	});

	test("no barrier: items flow independently (fast item finishes both stages while slow is still in stage 1)", async () => {
		const { outcome } = await run(
			`${META}
      const seen = []
      const out = await pipeline(
        ['slow', 'fast'],
        async (p) => { if (p === 'slow') await agent('warming'); seen.push('1:' + p); return p },
        (p) => { seen.push('2:' + p); return seen.slice() },
      )
      return { fastSnapshot: out[1], final: seen }`,
			// the agent call inside the slow item's stage 1 really takes time
			{
				agent: async (prompt) => {
					await new Promise((resolve) => setTimeout(resolve, 30));
					return { value: prompt };
				},
			},
		);
		expect(outcome.status).toBe("completed");
		// fast's stage-2 snapshot predates slow's stage-1 completion
		expect(outcome.result).toEqual({
			fastSnapshot: ["1:fast", "2:fast"],
			final: ["1:fast", "2:fast", "1:slow", "2:slow"],
		});
	});
});

describe("caps", () => {
	test("agent-count cap escapes as a fatal error", async () => {
		const { outcome } = await run(
			`${META}
      await agent('a')
      await agent('b')
      await agent('c')
      return 'done'`,
			{ maxAgents: 2 },
		);
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toBe(agentCapError);
	});
});

describe("budget", () => {
	const tokenAgent: AgentFn = async (prompt, _opts, call) => {
		call.addTokens(10);
		return { value: `ok:${prompt}` };
	};

	test("sequential spend up to the ceiling is fine, one more fails the run", async () => {
		const { outcome } = await run(`${META}await agent('a')\nawait agent('b')\nreturn 'done'`, {
			agent: tokenAgent,
			budgetTotal: 15,
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.progress.totalTokens).toBe(20);

		const over = await run(`${META}await agent('a')\nawait agent('b')\nawait agent('c')\nreturn 'done'`, {
			agent: tokenAgent,
			budgetTotal: 15,
		});
		expect(over.outcome.status).toBe("failed");
		expect(over.outcome.error).toContain("budget");
	});

	test("budget errors inside parallel() become null slots, not run failures", async () => {
		const { outcome } = await run(
			`${META}
      await agent('a')
      const rest = await parallel([() => agent('b'), () => agent('c')])
      return rest`,
			{ agent: tokenAgent, budgetTotal: 10 },
		);
		expect(outcome.status).toBe("completed");
		expect(outcome.result).toEqual([null, null]);
	});
});

describe("journal + resume", () => {
	test("journal records the full row lifecycle", async () => {
		const { journalFile } = await run(`${META}await agent('a')\nreturn 1`);
		const rows = Journal.load(journalFile).rows.map((r) => r.type);
		expect(rows).toEqual(["launched", "started", "result"]);
	});

	test("unchanged prefix replays from cache; agents are not re-run", async () => {
		const calls: string[] = [];
		const script = `${META}
      const a = await agent('first')
      const b = await agent('second')
      return [a, b]`;
		const first = await run(script, { agent: recordingAgent(calls) });
		expect(first.outcome.result).toEqual(["ok:first", "ok:second"]);

		const resumeFrom = Journal.load(first.journalFile);
		const strict: AgentFn = async (prompt) => {
			throw new Error(`agent must not be called on resume: ${prompt}`);
		};
		const second = await run(script, { agent: strict, resume: resumeFrom });
		expect(second.outcome.status).toBe("completed");
		expect(second.outcome.result).toEqual(["ok:first", "ok:second"]);
		const cachedRows = second.outcome.progress.rows.filter((r) => r.type === "workflow_agent" && r.cached === true);
		expect(cachedRows).toHaveLength(2);
		expect(calls).toEqual(["first", "second"]); // no additional calls
	});

	test("reordering agent calls invalidates the cache (chained keys)", async () => {
		const script1 = `${META}const a = await agent('first')\nconst b = await agent('second')\nreturn [a, b]`;
		const script2 = `${META}const b = await agent('second')\nconst a = await agent('first')\nreturn [a, b]`;
		const first = await run(script1);
		const calls: string[] = [];
		const second = await run(script2, {
			agent: recordingAgent(calls),
			resume: Journal.load(first.journalFile),
		});
		expect(second.outcome.result).toEqual(["ok:first", "ok:second"]);
		expect(calls).toEqual(["second", "first"]); // everything re-ran live
		expect(second.outcome.progress.rows.some((r) => r.type === "workflow_agent" && r.cached === true)).toBe(false);
	});

	test("first live call flips the cache off for the rest of the run", async () => {
		const script1 = `${META}await agent('same')\nawait agent('tail')\nreturn 1`;
		// run 2 drops the leading call: 'tail' now chains from an empty prevKey
		const script2 = `${META}await agent('tail')\nreturn 1`;
		const first = await run(script1);
		const calls: string[] = [];
		const second = await run(script2, {
			agent: recordingAgent(calls),
			resume: Journal.load(first.journalFile),
		});
		expect(calls).toEqual(["tail"]);
		expect(second.outcome.progress.rows.some((r) => r.type === "workflow_agent" && r.cached === true)).toBe(false);
	});
});

describe("workflow() nesting", () => {
	const CHILD = `${META.replace("'t'", "'child'")}
  const r = await agent('child-agent')
  return { child: r, got: args }`;

	function nestedRunner(
		agent: AgentFn,
		shared: SharedRunState,
		opts?: { maxAgents?: number; budgetTotal?: number | null },
	) {
		return async (nameOrRef: string | { scriptPath: string }, childArgs: unknown) => {
			if (nameOrRef !== "child") throw new Error(`Workflow "${nameOrRef}" not found`);
			const child = await executeWorkflow({
				runId: "wf_nestchild00",
				compiled: compileWorkflow(CHILD),
				args: childArgs,
				agent,
				journal: new Journal("/dev/null"),
				shared,
				maxAgents: opts?.maxAgents,
				budgetTotal: opts?.budgetTotal ?? null,
			});
			if (child.status === "completed") return child.result;
			if (child.status === "failed" && child.error === agentCapError) throw new WorkflowAgentCapError();
			throw new Error(`child ${child.status}${child.error ? `: ${child.error}` : ""}`);
		};
	}

	test("runs the child, returns its result, passes args", async () => {
		const result = await executeWorkflow({
			runId: "wf_nestparent00",
			compiled: compileWorkflow(`${META}
      const out = await workflow('child', { n: 7 })
      return out`),
			args: undefined,
			agent: echoAgent,
			journal: new Journal("/dev/null"),
			nestedWorkflow: nestedRunner(echoAgent, createSharedRunState()),
		});
		expect(result.status).toBe("completed");
		expect(result.result).toEqual({ child: "ok:child-agent", got: { n: 7 } });
	});

	test("second-level nesting is refused", async () => {
		const grandchild = `${META.replace("'t'", "'gc'")}
    await workflow('deeper')
    return 1`;
		const nested = async () => {
			// the child's executeWorkflow has no nestedWorkflow of its own, so its
			// script's workflow() call throws — this is the one-level enforcement
			const child = await executeWorkflow({
				runId: "wf_nestgc00000",
				compiled: compileWorkflow(grandchild),
				args: undefined,
				agent: echoAgent,
				journal: new Journal("/dev/null"),
			});
			if (child.status === "completed") return child.result;
			throw new Error(child.error ?? child.status);
		};
		const result = await executeWorkflow({
			runId: "wf_nestparent01",
			compiled: compileWorkflow(`${META}
      return await workflow('child', null)`),
			args: undefined,
			agent: echoAgent,
			journal: new Journal("/dev/null"),
			nestedWorkflow: nested,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("not available");
	});

	test("children share the parent's agent counter (cap is global)", async () => {
		const shared = createSharedRunState();
		const result = await executeWorkflow({
			runId: "wf_nestparent02",
			compiled: compileWorkflow(`${META}
      await agent('parent-agent')
      return await workflow('child', null)`),
			args: undefined,
			agent: echoAgent,
			journal: new Journal("/dev/null"),
			nestedWorkflow: nestedRunner(echoAgent, shared, 2),
			shared,
			maxAgents: 2,
		});
		expect(result.status).toBe("completed");
		expect(shared.agentCounter.count).toBe(2); // parent(1) + child(1), one pool

		const overShared = createSharedRunState();
		const over = await executeWorkflow({
			runId: "wf_nestparent03",
			compiled: compileWorkflow(`${META}
      await agent('p1')
      await agent('p2')
      return await workflow('child', null)`),
			args: undefined,
			agent: echoAgent,
			journal: new Journal("/dev/null"),
			nestedWorkflow: nestedRunner(echoAgent, overShared, { maxAgents: 2 }),
			shared: overShared,
			maxAgents: 2,
		});
		expect(over.status).toBe("failed");
		expect(over.error).toBe(agentCapError);
	});

	test("children share the parent's token budget pool", async () => {
		const tokenAgent: AgentFn = async (prompt, _opts, call) => {
			call.addTokens(10);
			return { value: `ok:${prompt}` };
		};
		const shared = createSharedRunState();
		const result = await executeWorkflow({
			runId: "wf_nestparent04",
			compiled: compileWorkflow(`${META}
      await agent('a')
      await agent('b')
      const out = await workflow('child', null)
      return out`),
			args: undefined,
			agent: tokenAgent,
			journal: new Journal("/dev/null"),
			nestedWorkflow: nestedRunner(tokenAgent, shared, { budgetTotal: 15 }),
			shared,
			budgetTotal: 15,
		});
		// parent spent 20 of a 15 budget; the child's agent call throws on the shared pool
		expect(result.status).toBe("failed");
		expect(result.error).toContain("budget");
		expect(shared.tokens.spent).toBe(20);
	});
});

describe("abort", () => {
	test("pre-aborted signal kills an agent-calling run", async () => {
		const ctrl = new AbortController();
		ctrl.abort("interrupt");
		const { outcome } = await run(`${META}await agent('a')\nreturn 1`, { signal: ctrl.signal });
		expect(outcome.status).toBe("killed");
		expect(outcome.error).toContain("aborted");
	});

	test("user-pause reason maps to paused", async () => {
		const ctrl = new AbortController();
		ctrl.abort("user-pause");
		const { outcome } = await run(`${META}await agent('a')\nreturn 1`, { signal: ctrl.signal });
		expect(outcome.status).toBe("paused");
	});
});
