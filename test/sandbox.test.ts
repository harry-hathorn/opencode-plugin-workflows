import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileWorkflow } from "../src/compile";
import { createFallbackSandbox, createSandbox, probeVm, type SandboxHooks } from "../src/sandbox";

beforeAll(() => {
	// keep any incidental artifact writes out of the real data dir
	process.env.XDG_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), "wf-sandbox-"));
});

const META = `export const meta = { name: 't', description: 'test workflow' }\n`;

function makeHooks(overrides: Partial<SandboxHooks> & { args?: unknown } = {}) {
	const logs: string[] = [];
	const agentCalls: string[] = [];
	const hooks: SandboxHooks = {
		agent: async (prompt: string) => {
			agentCalls.push(prompt);
			return `<${prompt}>`;
		},
		parallel: async (thunks: unknown) => {
			const fns = thunks as Array<() => unknown>;
			return Promise.all(fns.map((f) => Promise.resolve().then(() => f())));
		},
		pipeline: async (items: unknown, ...stages: unknown[]) => {
			const arr = items as unknown[];
			const fns = stages as Array<(prev: unknown, item: unknown, i: number) => unknown>;
			return Promise.all(
				arr.map(async (item, i) => {
					let v: unknown = item;
					for (const stage of fns) {
						if (v === null) break;
						v = await stage(v, item, i);
					}
					return v;
				}),
			);
		},
		workflow: async () => {
			throw new Error("nested workflows unavailable in this test");
		},
		log: (m) => logs.push(String(m)),
		phase: () => {},
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		args: undefined,
		...overrides,
	};
	return { hooks, logs, agentCalls };
}

async function runScript(source: string, hooks: SandboxHooks, timeoutMs = 2000): Promise<unknown> {
	const compiled = compileWorkflow(source);
	const sandbox = createSandbox(hooks);
	return sandbox.run(compiled.script, timeoutMs);
}

describe("vm probe", () => {
	test("hardened vm semantics available on this runtime", () => {
		expect(probeVm()).toBe(true);
	});
});

describe("hardened sandbox", () => {
	test("runs a trivial script", async () => {
		const { hooks } = makeHooks();
		expect(await runScript(`${META}return 1 + 2`, hooks)).toBe(3);
	});

	test("bridges log() and console to the workflow log", async () => {
		const { hooks, logs } = makeHooks();
		await runScript(`${META}console.log('via console')\nlog('via log')\nreturn 'done'`, hooks);
		expect(logs).toContain("via console");
		expect(logs).toContain("via log");
	});

	test("args is a fresh clone per access", async () => {
		const hostArgs = { list: [1, 2] };
		const { hooks } = makeHooks({ args: hostArgs });
		// mutations through one access are invisible to the next access, and the
		// host object is never touched — every read re-parses the original JSON
		const compiled = compileWorkflow(`${META}args.list.push(3)\nreturn [args.list.length, args.list.length].join()`);
		const sandbox = createSandbox(hooks);
		expect(await sandbox.run(compiled.script, 2000)).toBe("2,2");
		expect(hostArgs.list).toEqual([1, 2]);
	});

	test("eval and Function constructor are blocked", async () => {
		const { hooks } = makeHooks();
		const out = await runScript(
			`${META}
      let evalBlocked = false
      let fnBlocked = false
      try { eval('1') } catch { evalBlocked = true }
      try { new Function('return 1') } catch { fnBlocked = true }
      return [evalBlocked, fnBlocked].join()`,
			hooks,
		);
		expect(out).toBe("true,true");
	});

	test("Math.random and Date.now throw; new Date(0) works", async () => {
		const { hooks } = makeHooks();
		// indirection keeps the banned literals out of the SOURCE (the static
		// determinism check would reject them before the sandbox ever ran)
		const out = await runScript(
			`${META}
      const M = Math, D = Date
      let randomErr = ''
      let nowErr = ''
      let dateErr = ''
      try { M.random() } catch (e) { randomErr = e.message }
      try { D.now() } catch (e) { nowErr = e.message }
      try { new D() } catch (e) { dateErr = e.message }
      const dated = new D(0)
      return [randomErr, nowErr, dateErr, typeof dated].join('|')`,
			hooks,
		);
		const [randomErr, nowErr, dateErr, datedType] = String(out).split("|");
		expect(randomErr).toContain("Math.random");
		expect(nowErr).toContain("Date.now");
		expect(dateErr).toContain("Date.now");
		expect(datedType).toBe("object");
	});

	test("prototype pollution is contained", async () => {
		const { hooks } = makeHooks();
		const out = await runScript(
			`${META}
      try { ({}).__proto__.polluted = 1 } catch {}
      return ({}).polluted === undefined`,
			hooks,
		);
		expect(out).toBe(true);
	});

	test("setTimeout works and resolves awaits", async () => {
		const { hooks } = makeHooks();
		const out = await runScript(
			`${META}return await new Promise(resolve => setTimeout(() => resolve('ticked'), 10))`,
			hooks,
		);
		expect(out).toBe("ticked");
	});

	test("sync watchdog kills an infinite loop", async () => {
		const { hooks } = makeHooks();
		const compiled = compileWorkflow(`${META}for (;;) {}\nreturn 'never'`);
		const sandbox = createSandbox(hooks);
		await expect(sandbox.run(compiled.script, 150)).rejects.toThrow();
	});

	test("agent is callable across the boundary", async () => {
		const { hooks, agentCalls } = makeHooks();
		const out = await runScript(`${META}return await agent('hi')`, hooks);
		expect(out).toBe("<hi>");
		expect(agentCalls).toEqual(["hi"]);
	});

	test("pre-aborted signal rejects after completion check", async () => {
		const { hooks } = makeHooks();
		const ctrl = new AbortController();
		ctrl.abort("interrupt");
		const compiled = compileWorkflow(`${META}return 'fast'`);
		const sandbox = createSandbox(hooks, ctrl.signal);
		await expect(sandbox.run(compiled.script, 1000)).rejects.toThrow("Workflow aborted");
	});
});

describe("fallback sandbox", () => {
	test("runs a trivial script in the same realm", async () => {
		const { hooks, logs } = makeHooks();
		const compiled = compileWorkflow(`${META}log('fallback log')\nreturn 'fb'`);
		const sandbox = createFallbackSandbox(hooks, compiled.iifeSource);
		expect(sandbox.isFallback).toBe(true);
		expect(await sandbox.run(compiled.script, 1000)).toBe("fb");
		expect(logs).toContain("fallback log");
	});
});
