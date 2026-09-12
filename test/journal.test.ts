import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cacheKey,
	canonicalOpts,
	isValidRunId,
	Journal,
	newRunId,
	runsRoot,
	safeRunId,
	stableStringify,
} from "../src/journal";

let tmp: string;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-"));
});

describe("canonical opts & cache keys", () => {
	test("label and phase are excluded from the key", () => {
		expect(canonicalOpts({ label: "x", phase: "y", model: "m" })).toBe(canonicalOpts({ model: "m" }));
	});

	test("key order does not matter", () => {
		const schema = { type: "object", properties: { a: { type: "string" } } };
		expect(canonicalOpts({ schema, model: "m", effort: "high" })).toBe(
			canonicalOpts({ effort: "high", model: "m", schema }),
		);
	});

	test("stableStringify sorts recursively and drops functions", () => {
		expect(stableStringify({ b: { d: 1, c: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"b":{"c":2,"d":1}}');
		expect(stableStringify({ f: () => 1, keep: 2 })).toBe('{"keep":2}');
		expect(stableStringify([() => 1, 2])).toBe("[null,2]");
	});

	test("keys chain on prevKey", () => {
		const k1 = cacheKey("prompt", { model: "m" }, "");
		expect(k1).toMatch(/^v2:[0-9a-f]{64}$/);
		expect(k1).toBe(cacheKey("prompt", { model: "m" }, ""));
		expect(cacheKey("prompt", { model: "m" }, k1)).not.toBe(k1);
		expect(cacheKey("prompt2", { model: "m" }, k1)).not.toBe(cacheKey("prompt", { model: "m" }, k1));
	});
});

describe("journal load/replicate", () => {
	test("append → load roundtrip builds results/started/failed", () => {
		const file = path.join(tmp, "run-a", "journal.jsonl");
		const j = new Journal(file);
		j.append({ type: "launched" });
		j.append({ type: "started", key: "k1", agentId: "a1", label: "l1" });
		j.append({ type: "result", key: "k1", agentId: "a1", result: { value: 42 } });
		j.append({ type: "started", key: "k2", agentId: "a2" });
		j.append({ type: "failed", key: "k2", agentId: "a2" });
		const loaded = Journal.load(file);
		expect(loaded.rows).toHaveLength(5);
		expect(loaded.results.get("k1")).toEqual({ value: 42 });
		expect(loaded.started.has("k1")).toBe(true);
		expect(loaded.failed.has("k2")).toBe(true);
	});

	test("torn tail line is ignored", () => {
		const file = path.join(tmp, "run-b", "journal.jsonl");
		const j = new Journal(file);
		j.append({ type: "launched" });
		fs.appendFileSync(file, '{"type":"resu');
		const loaded = Journal.load(file);
		expect(loaded.rows).toHaveLength(1);
	});

	test("replicate copies rows into a new journal", () => {
		const src = path.join(tmp, "run-c", "journal.jsonl");
		const j = new Journal(src);
		j.append({ type: "started", key: "k", agentId: "a" });
		j.append({ type: "result", key: "k", agentId: "a", result: "v" });

		const dst = path.join(tmp, "run-d", "journal.jsonl");
		new Journal(dst).replicate(Journal.load(src).rows);
		const reloaded = Journal.load(dst);
		expect(reloaded.rows).toHaveLength(2);
		expect(reloaded.results.get("k")).toBe("v");
	});

	test("missing file loads empty", () => {
		const loaded = Journal.load(path.join(tmp, "nope", "journal.jsonl"));
		expect(loaded.rows).toHaveLength(0);
	});
});

describe("run ids", () => {
	test("newRunId shape", () => {
		const id = newRunId();
		expect(isValidRunId(id)).toBe(true);
		expect(id).toMatch(/^wf_[a-z0-9-]{6,}$/);
	});

	test("validation and path-escape guard", () => {
		expect(isValidRunId("wf_abc123")).toBe(true);
		expect(isValidRunId("wf_short")).toBe(false);
		expect(isValidRunId("WF_abc123")).toBe(false);
		expect(safeRunId("wf_abc123")).toBe("wf_abc123");
		expect(safeRunId("wf_..%2f")).toBeNull();
		expect(safeRunId("../etc/passwd")).toBeNull();
	});

	test("runsRoot honors XDG_DATA_HOME", () => {
		process.env.XDG_DATA_HOME = tmp;
		expect(runsRoot()).toBe(path.join(tmp, "opencode", "workflows"));
	});
});
