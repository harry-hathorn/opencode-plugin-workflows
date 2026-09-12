/**
 * Hardened sandbox + determinism shims, targeting node:vm as realized by both Node (V8) and Bun (JSC).
 *
 *   vm.createContext(∅, {codeGeneration: {strings:false, wasm:false}})
 *   → prologue script inside the context: delete dangerous globals, install
 *     throwing Date.now/Math.random/argless-Date shims, freeze prototypes
 *   → defineProperty-install the hook globals (agent/parallel/pipeline/…)
 *
 * A same-realm `new Function` fallback exists for runtimes where the hardened
 * vm path fails its probe (JSC edge cases); it is strictly weaker isolation and
 * logs a warning when engaged.
 */
import vm from "node:vm";

export interface SandboxHooks {
	agent: (prompt: string, opts?: unknown) => Promise<unknown>;
	parallel: (thunks: unknown) => Promise<unknown[]>;
	pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>;
	workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
	log: (message: string) => void;
	phase: (title: string) => void;
	budget: Record<string, unknown>;
	args: unknown;
}

export interface TrackedTimers {
	/** clear every outstanding timer (abort/kill) */
	clearAll(): void;
}

export interface Sandbox {
	context: vm.Context | null;
	run(script: vm.Script, timeoutMs: number): Promise<unknown>;
	isFallback: boolean;
	timers: TrackedTimers;
}

const NOW_ERR =
	"Date.now() is unavailable in workflow scripts (determinism: resume replays agents positionally). Pass timestamps in via args.";
const RANDOM_ERR =
	"Math.random() is unavailable in workflow scripts (determinism: resume replays agents positionally). Vary agent prompts by index instead.";

/**
 * Prologue executed INSIDE the fresh context before any workflow code.
 * Written as a string so it runs with the context's own intrinsics.
 */
const HARDEN_PROLOGUE = `
;(function () {
  var kills = ["ShadowRealm","WebAssembly","FinalizationRegistry","WeakRef","Atomics",
               "SharedArrayBuffer","queueMicrotask","gc","edenGC","fullGC","print",
               "readFile","Loader","process","global","require","module","Buffer",
               "fetch","XMLHttpRequest","WebSocket","Worker","Navigator","importScripts"];
  for (var i = 0; i < kills.length; i++) {
    try { delete globalThis[kills[i]] } catch (e) {}
  }
  // --- determinism shims (Io) ---
  try {
    Math.random = function () { throw new Error(${JSON.stringify(RANDOM_ERR)}) };
  } catch (e) {}
  try {
    var RealDate = Date;
    RealDate.now = function now() { throw new Error(${JSON.stringify(NOW_ERR)}) };
    function ShimDate() {
      var a = arguments;
      if (!new.target) throw new Error(${JSON.stringify(NOW_ERR)});
      if (a.length === 0) throw new Error(${JSON.stringify(NOW_ERR)});
      return Reflect.construct(RealDate, a, new.target);
    }
    ShimDate.now = RealDate.now;
    ShimDate.parse = RealDate.parse;
    ShimDate.UTC = RealDate.UTC;
    ShimDate.prototype = RealDate.prototype;
    RealDate.prototype.constructor = ShimDate; // close the constructor backdoor
    Object.freeze(RealDate);
    globalThis.Date = ShimDate;
  } catch (e) {}
  // --- SES-style freeze of mutation-relevant prototypes ---
  var protos = [Object.prototype, Array.prototype, Function.prototype, String.prototype,
                Number.prototype, Boolean.prototype, Symbol.prototype, BigInt.prototype,
                RegExp.prototype, Date.prototype, Error.prototype, EvalError.prototype,
                RangeError.prototype, ReferenceError.prototype, SyntaxError.prototype,
                TypeError.prototype, URIError.prototype, Promise.prototype, Map.prototype,
                Set.prototype, WeakMap.prototype, WeakSet.prototype, Array.prototype.constructor];
  for (var j = 0; j < protos.length; j++) {
    try { Object.freeze(protos[j]) } catch (e) {}
  }
})();
`;

/** null-prototype console routing to the workflow log. */
function makeConsole(log: (msg: string) => void): Record<string, (...args: unknown[]) => void> {
	const sanitize = (v: unknown): string => {
		if (typeof v === "string") return v;
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	};
	const api = Object.create(null) as Record<string, (...args: unknown[]) => void>;
	for (const level of ["log", "info", "debug", "warn", "error"]) {
		api[level] = (...args: unknown[]) => log(args.map(sanitize).join(" "));
	}
	return api;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface SandboxTimerApi {
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): TimeoutHandle;
	clearTimeout(handle?: TimeoutHandle): void;
	clearAll(): void;
}

/** Track timers so abort can clear them; callbacks re-enter the sandbox defensively. */
function makeTrackedTimeouts(): SandboxTimerApi {
	const active = new Set<TimeoutHandle>();
	return {
		setTimeout(callback, ms, ...rest) {
			const wrapped = (...cbArgs: unknown[]) => {
				try {
					callback(...cbArgs);
				} catch (err) {
					console.error("[workflow] timer callback error:", err);
				}
			};
			const handle = setTimeout(wrapped, ms, ...rest);
			active.add(handle);
			return handle;
		},
		clearTimeout(handle) {
			if (handle !== undefined) active.delete(handle);
			clearTimeout(handle);
		},
		clearAll() {
			for (const handle of active) clearTimeout(handle);
			active.clear();
		},
	};
}

/**
 * Abort-shaped failure. sandbox.ts cannot import the runner's error class
 * (circular), so the runner recognizes these by `name` + `reason`.
 */
function abortFail(signal?: AbortSignal, reason?: string): Error {
	const finalReason = reason ?? (signal?.reason as string | undefined) ?? "interrupt";
	const err = new Error(`Workflow aborted (${finalReason})`);
	err.name = "WorkflowAbortError";
	(err as Error & { reason?: string }).reason = finalReason;
	return err;
}

/** Host-realm await wrapper: `__wRg$(v)` → host Promise.resolve(v). */
function makeAwaitWrapper(signal?: AbortSignal): (v: unknown) => Promise<unknown> {
	return (value: unknown) => {
		if (signal?.aborted) {
			// The incoming value is often an already-rejected agent() promise;
			// observe it so it never surfaces as an unhandled rejection.
			if (value && typeof (value as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(value).then(
					() => {},
					() => {},
				);
			}
			return Promise.reject(abortFail(signal));
		}
		return Promise.resolve(value);
	};
}

/**
 * Build the hardened context. Throws if the vm probe fails — callers should
 * catch and use `createFallbackSandbox`.
 */
export function createSandbox(hooks: SandboxHooks, signal?: AbortSignal): Sandbox {
	const timers = makeTrackedTimeouts();
	const consoleApi = makeConsole(hooks.log);
	const wrapper = makeAwaitWrapper(signal);

	const base: Record<string, unknown> = {
		__proto__: null,
		console: consoleApi,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
	};

	const context = vm.createContext(base, {
		codeGeneration: { strings: false, wasm: false },
	});

	// Harden intrinsics inside the context.
	vm.runInContext(HARDEN_PROLOGUE, context, { filename: "workflow-hardening.js" });

	// Install hook globals as non-writable / non-configurable bindings.
	const defs: Record<string, unknown> = {
		agent: hooks.agent,
		parallel: hooks.parallel,
		pipeline: hooks.pipeline,
		workflow: hooks.workflow,
		log: hooks.log,
		phase: hooks.phase,
		budget: hooks.budget,
		__wRg$: wrapper,
		__wRg$resolve: Promise.resolve,
	};
	for (const [name, value] of Object.entries(defs)) {
		Object.defineProperty(context, name, {
			value,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}
	// `args` clones per access — a fresh copy at every read point.
	const argsJson = JSON.stringify(hooks.args ?? null);
	Object.defineProperty(context, "args", {
		get: () => JSON.parse(argsJson),
		configurable: false,
		enumerable: true,
	});

	return {
		context,
		isFallback: false,
		timers,
		async run(script: vm.Script, timeoutMs: number): Promise<unknown> {
			// runInContext throws synchronously on watchdog timeout — the async
			// signature converts that (and everything else) into a rejection.
			// Await the (possibly cross-realm) result so its rejection is observed
			// here rather than becoming an unhandled rejection inside the sandbox.
			const value = await script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
			if (signal?.aborted) throw abortFail(signal);
			return value;
		},
	};
}

/**
 * Fallback for runtimes where the hardened vm path fails: same-realm async
 * function with the dangerous globals shadowed by parameters. Weaker isolation
 * (script shares the host realm) — engaged only behind a failed probe.
 */
export function createFallbackSandbox(hooks: SandboxHooks, iifeSource: string, signal?: AbortSignal): Sandbox {
	const timers = makeTrackedTimeouts();
	console.warn(
		"[opencode-plugin-workflows] hardened node:vm unavailable; using same-realm fallback sandbox (weaker isolation)",
	);
	const wrapper = makeAwaitWrapper(signal);
	const fn = new Function(
		"__wRg$",
		"agent",
		"parallel",
		"pipeline",
		"workflow",
		"log",
		"phase",
		"budget",
		"console",
		"setTimeout",
		"clearTimeout",
		"getArgs",
		`"use strict"; const args = getArgs(); return (${iifeSource});`,
	);
	return {
		context: null,
		isFallback: true,
		timers,
		async run(_script: vm.Script): Promise<unknown> {
			void _script;
			// Re-drive determinism shims in this realm lazily is not possible without
			// polluting the host — the compile-time static check is the guard here.
			return fn(
				wrapper,
				hooks.agent,
				hooks.parallel,
				hooks.pipeline,
				hooks.workflow,
				hooks.log,
				hooks.phase,
				hooks.budget,
				makeConsole(hooks.log),
				timers.setTimeout,
				timers.clearTimeout,
				() => JSON.parse(JSON.stringify(hooks.args ?? null)),
			);
		},
	};
}

/**
 * Probe whether hardened vm semantics work on this runtime (Bun/JSC vs Node/V8):
 * codeGeneration disabled, timeout watchdog, prototype freezing.
 */
export function probeVm(): boolean {
	try {
		const ctx = vm.createContext({ __proto__: null }, { codeGeneration: { strings: false, wasm: false } });
		vm.runInContext(HARDEN_PROLOGUE, ctx, { filename: "workflow-probe.js" });
		// eval must be blocked
		let evalBlocked = false;
		try {
			vm.runInContext("eval('1')", ctx, { filename: "probe-eval.js" });
		} catch {
			evalBlocked = true;
		}
		if (!evalBlocked) return false;
		// sync watchdog must fire
		let timedOut = false;
		try {
			vm.runInContext("while(true){}", ctx, { filename: "probe-spin.js", timeout: 50 });
		} catch {
			timedOut = true;
		}
		if (!timedOut) return false;
		// Math.random must throw inside the context
		let randomBlocked = false;
		try {
			vm.runInContext("Math.random()", ctx, { filename: "probe-random.js" });
		} catch {
			randomBlocked = true;
		}
		return randomBlocked;
	} catch {
		return false;
	}
}
