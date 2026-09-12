/**
 * Saved-workflow registry.
 * Discovery: `~/.config/opencode/workflows` + `.opencode/workflows` (recursive, `.js` files) on
 * the project chain (outermost → innermost), user-global LAST (wins).
 * `.js` only; meta-only parse; last-wins precedence; sorted by name.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_SCRIPT_CHARS, parseMeta, type WorkflowMeta } from "./compile";

export interface SavedWorkflow {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowMeta["phases"];
	file: string;
	source: "user" | "project";
}

function globalConfigDir(): string {
	return process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");
}

/** Every `.opencode` dir from `directory` up to `worktree` (inclusive), root-last. */
export function projectConfigDirs(directory: string, worktree: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(directory);
	const root = path.resolve(worktree);
	for (;;) {
		dirs.push(path.join(current, ".opencode"));
		if (current === root || path.dirname(current) === current) break;
		current = path.dirname(current);
		if (!current.startsWith(root)) {
			// directory outside worktree — walk to its own root instead
			if (path.dirname(current) === current) break;
		}
	}
	return dirs;
}

function scanDir(dir: string, source: SavedWorkflow["source"]): SavedWorkflow[] {
	const workflowsDir = path.join(dir, "workflows");
	let files: string[];
	try {
		files = collectJsFiles(workflowsDir);
	} catch {
		return [];
	}
	const found: SavedWorkflow[] = [];
	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (stat.size > MAX_SCRIPT_CHARS + 1) continue; // oversize → skip
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		try {
			const { meta } = parseMeta(sourceText);
			found.push({
				name: meta.name,
				description: meta.description,
				whenToUse: meta.whenToUse,
				phases: meta.phases,
				file,
				source,
			});
		} catch {
			// unparsable shadow candidate — skip with a warning
			console.warn(`[opencode-plugin-workflows] skipping unparsable workflow file: ${file}`);
		}
	}
	return found;
}

function collectJsFiles(root: string): string[] {
	const out: string[] = [];
	const walkDir = (dir: string, depth: number) => {
		if (depth > 8) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walkDir(full, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
		}
	};
	walkDir(root, 0);
	return out.sort();
}

/** Discover saved workflows; later entries win on name collision. */
export function discoverWorkflows(directory: string, worktree: string): SavedWorkflow[] {
	const byName = new Map<string, SavedWorkflow>();
	for (const dir of projectConfigDirs(directory, worktree)) {
		for (const wf of scanDir(dir, "project")) byName.set(wf.name, wf);
	}
	for (const wf of scanDir(globalConfigDir(), "user")) byName.set(wf.name, wf);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a saved workflow by name → its script source. */
export function resolveWorkflow(
	name: string,
	directory: string,
	worktree: string,
): { script: string; saved: SavedWorkflow } | null {
	const workflows = discoverWorkflows(directory, worktree);
	const hit = workflows.find((w) => w.name === name);
	if (!hit) return null;
	try {
		const script = fs.readFileSync(hit.file, "utf8");
		if (script.length > MAX_SCRIPT_CHARS) return null;
		return { script, saved: hit };
	} catch {
		return null;
	}
}
