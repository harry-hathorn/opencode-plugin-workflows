/**
 * Filesystem layout shared by the server half and the TUI half:
 *
 *   ~/.local/share/opencode/workflows/<runId>/
 *     journal.jsonl        # {launched|started|result|failed} rows, resume cache
 *     script.js            # persisted script for this invocation
 *     snapshot.json        # written on settle (status, result, progress rows)
 *     control.jsonl        # TUI → server control ops (kill/pause), 0600
 *
 * Kept dependency-free (node builtins only) so the TUI bundle can inline it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function runsRoot(): string {
	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "share");
	return path.join(base, "opencode", "workflows");
}

export function runDir(runId: string): string {
	return path.join(runsRoot(), runId);
}

export function journalPath(runId: string): string {
	return path.join(runDir(runId), "journal.jsonl");
}

export function controlPath(runId: string): string {
	return path.join(runDir(runId), "control.jsonl");
}

/** Append one line to a run's control file, creating it 0600 (same trust level as script.js). */
export function appendControlLine(runId: string, line: string): void {
	const file = controlPath(runId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const had = fs.existsSync(file);
	fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, { mode: 0o600 });
	if (!had) {
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// best effort — the run dir already lives under the user's data dir
		}
	}
}
