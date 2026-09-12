import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkflows, resolveWorkflow } from "../src/registry";

let project: string;
let userGlobal: string;

beforeAll(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-"));
	userGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "wf-usercfg-"));
	process.env.OPENCODE_CONFIG_DIR = userGlobal;
	process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wf-data-"));

	const wfDir = path.join(project, ".opencode", "workflows");
	fs.mkdirSync(path.join(wfDir, "sub"), { recursive: true });
	fs.writeFileSync(
		path.join(wfDir, "alpha.js"),
		`export const meta = { name: 'alpha', description: 'first' }\nreturn 'alpha-result'`,
	);
	fs.writeFileSync(
		path.join(wfDir, "sub", "nested.js"),
		`export const meta = { name: 'nested', description: 'from subdir' }\nreturn 'nested-result'`,
	);
	fs.writeFileSync(
		path.join(wfDir, "wrong-ext.ts"),
		`export const meta = { name: 'wrong', description: 'ts file' }\nreturn 1`,
	);
	fs.writeFileSync(
		path.join(wfDir, "dup-early.js"),
		`export const meta = { name: 'dup', description: 'early file' }\nreturn 'early'`,
	);
	fs.writeFileSync(
		path.join(wfDir, "dup-late.js"),
		`export const meta = { name: 'dup', description: 'late file' }\nreturn 'late'`,
	);
	fs.writeFileSync(path.join(wfDir, "broken.js"), `export const meta = notALiteral\nreturn 1`);
});

describe("discovery", () => {
	test("finds .js files recursively, skips other extensions and unparsable metas", () => {
		const found = discoverWorkflows(project, project).map((w) => w.name);
		expect(found).toContain("alpha");
		expect(found).toContain("nested");
		expect(found).not.toContain("wrong");
		expect(found).not.toContain("broken");
	});

	test("duplicate names: last-sorted file in the same dir wins", () => {
		const dup = discoverWorkflows(project, project).find((w) => w.name === "dup");
		expect(dup?.description).toBe("late file");
		expect(dup?.source).toBe("project");
	});

	test("user-global config dir wins over project files with the same name", () => {
		const globalWfDir = path.join(userGlobal, "workflows");
		fs.mkdirSync(globalWfDir, { recursive: true });
		fs.writeFileSync(
			path.join(globalWfDir, "override.js"),
			`export const meta = { name: 'dup', description: 'user global wins' }\nreturn 'user'`,
		);
		const dup = discoverWorkflows(project, project).find((w) => w.name === "dup");
		expect(dup?.description).toBe("user global wins");
		expect(dup?.source).toBe("user");
	});

	test("resolveWorkflow returns the script source", () => {
		const hit = resolveWorkflow("alpha", project, project);
		expect(hit?.script).toContain("alpha-result");
		expect(hit?.saved.name).toBe("alpha");
		expect(resolveWorkflow("nope", project, project)).toBeNull();
	});
});
