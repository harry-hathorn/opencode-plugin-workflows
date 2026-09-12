import { describe, expect, test } from "bun:test";
import * as acorn from "acorn";
import {
	checkBannedSyntax,
	checkDeterminism,
	collectAwaitEdits,
	compileWorkflow,
	parseMeta,
	WorkflowCompileError,
} from "../src/compile";

const META = `export const meta = { name: 't', description: 'test workflow' }\n`;

function parse(source: string): acorn.Program {
	return acorn.parse(source, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowReturnOutsideFunction: true,
		locations: true,
	}) as acorn.Program;
}

function expectCompileError(source: string, ...needles: string[]) {
	try {
		compileWorkflow(source);
	} catch (err) {
		expect(err).toBeInstanceOf(WorkflowCompileError);
		const msg = (err as Error).message;
		for (const needle of needles) expect(msg).toContain(needle);
		return;
	}
	throw new Error(`expected compile error containing ${JSON.stringify(needles)}`);
}

describe("meta literal parsing", () => {
	test("accepts full meta", () => {
		const source = `export const meta = {
      name: 'find-flaky-tests',
      description: 'Find flaky tests',
      whenToUse: 'when CI flakes',
      phases: [{ title: 'Scan', detail: 'grep logs', model: 'provider/model' }, { title: 'Fix' }],
    }
    return 1`;
		const { meta, body } = parseMeta(source);
		expect(meta.name).toBe("find-flaky-tests");
		expect(meta.phases).toHaveLength(2);
		expect(meta.phases![0]).toEqual({ title: "Scan", detail: "grep logs", model: "provider/model" });
		expect(body).toContain("return 1");
	});

	test("accepts template literals without interpolation and negative numbers", () => {
		const { meta } = parseMeta(
			`export const meta = { name: 'x', description: \`plain\`, phases: [{ title: 'a' }], other: -1, list: ['a', 'b'] }\nreturn 1`,
		);
		expect(meta.description).toBe("plain");
	});

	test("rejects TypeScript syntax with the plain-JS hint", () => {
		expectCompileError(
			`export const meta = { name: 'x', description: 'd' }\nconst xs: string[] = []\nreturn 1`,
			"plain JavaScript",
		);
	});

	test("rejects missing meta as first statement", () => {
		expectCompileError(`const x = 1\nreturn x`, "meta");
	});

	test("rejects non-literal values", () => {
		expectCompileError(`export const meta = { name: 'x', description: \`\${name}\` }\nreturn 1`, "interpolation");
		expectCompileError(
			`export const meta = { name: 'x', description: 'd', phases: [{ title: 'a', ...extra }] }\nconst extra = { detail: 'd' }\nreturn 1`,
			"spread",
		);
		expectCompileError(`export const meta = { [k]: 'x', description: 'd' }\nconst k = 'name'\nreturn 1`, "computed");
		expectCompileError(`export const meta = { name, description: 'd' }\nreturn 1`, "pure literal");
		expectCompileError(
			`export const meta = { name: 'x', description: 'd', ['ph' + 'ases']: [] }\nreturn 1`,
			"pure literal",
		);
	});

	test("rejects reserved keys and sparse arrays", () => {
		expectCompileError(`export const meta = { name: 'x', description: 'd', __proto__: null }\nreturn 1`, "reserved");
		expectCompileError(`export const meta = { name: 'x', description: 'd', list: [, 1] }\nreturn 1`, "sparse");
	});

	test("rejects invalid shapes", () => {
		expectCompileError(`export const meta = { description: 'd' }\nreturn 1`, "name");
		expectCompileError(`export const meta = { name: 'x', description: 'd', phases: 'nope' }\nreturn 1`, "phases");
		expectCompileError(
			`export const meta = { name: 'x', description: 'd', phases: [{ title: '' }] }\nreturn 1`,
			"title",
		);
	});
});

describe("banned syntax", () => {
	test("with statements", () => {
		expectCompileError(`${META}with (Math) { return 1 }`, "with");
	});

	test("dynamic import", () => {
		expectCompileError(`${META}return import('fs')`, "Dynamic import");
	});

	test("import/export declarations in the body", () => {
		expectCompileError(`${META}import fs from 'fs'\nreturn 1`, "import/export");
		expectCompileError(`${META}export const x = 1\nreturn x`, "import/export");
	});

	test("using declarations are refused by the parser", () => {
		expectCompileError(`${META}using res = { [Symbol.dispose]() {} }\nreturn 1`);
	});

	test("__wRg$ identifiers are reserved", () => {
		expectCompileError(`${META}const __wRg$x = 1\nreturn __wRg$x`, "reserved");
	});

	test("clean script passes checkBannedSyntax", () => {
		const src = `${META}const xs = [1, 2].map(n => n * 2)\nreturn xs`;
		expect(() => checkBannedSyntax(parse(src), src)).not.toThrow();
	});
});

describe("determinism bans", () => {
	test("bans the four nondeterministic forms", () => {
		expectCompileError(`${META}return Date.now()`, "deterministic");
		expectCompileError(`${META}return Math.random()`, "deterministic");
		expectCompileError(`${META}const d = new Date()\nreturn 1`, "deterministic");
		expectCompileError(`${META}const s = Date()\nreturn s`, "deterministic");
	});

	test("allows deterministic Date usage and clean source", () => {
		const ok = `${META}const d = new Date(0)\nreturn d.getUTCFullYear()`;
		expect(() => checkDeterminism(ok)).not.toThrow();
		expect(() =>
			checkDeterminism(`${META}return 'Date.now mentioned in a string is still banned — the regex is textual'`),
		).toThrow();
	});
});

describe("await-wrap transform", () => {
	test("wraps await arguments", () => {
		const src = `${META}const x = await foo()\nreturn x`;
		const edits = collectAwaitEdits(parse(src), src);
		expect(edits).toHaveLength(1);
		expect(edits[0].text).toBe("__wRg$(foo())");
	});

	test("nested awaits keep only the innermost", () => {
		const src = `${META}const x = await bar(await baz())\nreturn x`;
		const edits = collectAwaitEdits(parse(src), src);
		expect(edits).toHaveLength(1);
		expect(edits[0].text).toBe("__wRg$(baz())");
	});

	test("wraps returns inside async functions but not top-level returns", () => {
		const src = `${META}
async function f() { return compute() }
const g = async () => compute()
return compute()
`;
		const edits = collectAwaitEdits(parse(src), src);
		expect(edits).toHaveLength(2);
		expect(edits.every((e) => e.text === "__wRg$(compute())")).toBe(true);
	});

	test("compiled iife contains the wrapper", () => {
		const compiled = compileWorkflow(`${META}const x = await agent('hi')\nreturn x`);
		expect(compiled.iifeSource).toContain("__wRg$(agent('hi'))");
		expect(compiled.meta.name).toBe("t");
	});
});
