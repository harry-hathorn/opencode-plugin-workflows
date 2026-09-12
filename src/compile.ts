/**
 * Workflow script compilation: meta parser, banned-syntax walk, and the
 * determinism static check.
 *
 * Pipeline: acorn ES-module parse (allowReturnOutsideFunction — scripts may
 * `return` at top level) → first statement must be `export const meta = {…}`
 * pure literal → banned-syntax walk → determinism regex check → await-wrap AST
 * transform → async IIFE source → vm.Script.
 */

import vm from "node:vm";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

export const MAX_SCRIPT_CHARS = 524288;

export interface WorkflowMeta {
	name: string;
	description: string;
	title?: string;
	whenToUse?: string;
	phases?: { title: string; detail?: string; model?: string }[];
}

export interface CompiledWorkflow {
	meta: WorkflowMeta;
	/** transformed body wrapped as `(async () => { … })()` — ready for vm.Script */
	iifeSource: string;
	script: vm.Script;
}

export class WorkflowCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowCompileError";
	}
}

const PLAIN_JS_HINT =
	"Workflow scripts must be plain JavaScript — common causes are TypeScript syntax (type annotations, interfaces, generics), JSX, or anything outside standard ECMAScript.";

// ---------------------------------------------------------------------------
// Parse + meta extraction
// ---------------------------------------------------------------------------

function parseScript(source: string): acorn.Program {
	try {
		return acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowReturnOutsideFunction: true,
			locations: true,
		}) as acorn.Program;
	} catch (err) {
		const e = err as Error & { loc?: { line: number; column: number } };
		const where = e.loc ? ` (line ${e.loc.line}, column ${e.loc.column + 1})` : "";
		throw new WorkflowCompileError(`Syntax error${where}: ${e.message}\n${PLAIN_JS_HINT}`);
	}
}

/** Render an ~80-column caret snippet under the offending line. */
function caretSnippet(source: string, line: number, column: number): string {
	const lines = source.split("\n");
	const text = (lines[line - 1] ?? "").slice(0, 200);
	const pointer = `${" ".repeat(Math.min(column, 79))}^`;
	const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text;
	return `${clipped}\n${pointer}`;
}

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Statically evaluate a meta literal — only plain literal node types allowed. */
function evaluateMetaLiteral(node: acorn.Node, source: string): unknown {
	switch (node.type) {
		case "Literal":
			return (node as acorn.Literal).value;
		case "TemplateLiteral": {
			const tpl = node as acorn.TemplateLiteral;
			if (tpl.expressions.length > 0) {
				throw new WorkflowCompileError("meta must be a pure literal — template interpolation is not allowed.");
			}
			return tpl.quasis[0]?.value.cooked ?? "";
		}
		case "UnaryExpression": {
			const u = node as acorn.UnaryExpression;
			const num = u.argument.type === "Literal" ? (u.argument as acorn.Literal).value : undefined;
			if (u.operator !== "-" || typeof num !== "number") {
				throw new WorkflowCompileError(
					"meta must be a pure literal — only negative number literals are allowed as unary expressions.",
				);
			}
			return -num;
		}
		case "ArrayExpression": {
			const arr = node as acorn.ArrayExpression;
			const out: unknown[] = [];
			for (const el of arr.elements) {
				if (el === null)
					throw new WorkflowCompileError("meta must be a pure literal — sparse arrays are not allowed.");
				if (el.type === "SpreadElement")
					throw new WorkflowCompileError("meta must be a pure literal — spread is not allowed.");
				out.push(evaluateMetaLiteral(el, source));
			}
			return out;
		}
		case "ObjectExpression": {
			const obj = node as acorn.ObjectExpression;
			const out: Record<string, unknown> = {};
			for (const prop of obj.properties) {
				if (prop.type === "SpreadElement" || (prop as { type?: string }).type === "SpreadElement") {
					throw new WorkflowCompileError("meta must be a pure literal — spread is not allowed.");
				}
				if (prop.type !== "Property") {
					throw new WorkflowCompileError("meta must be a pure literal — methods/accessors are not allowed.");
				}
				if (prop.computed || prop.kind !== "init" || prop.shorthand) {
					throw new WorkflowCompileError(
						"meta must be a pure literal — computed keys, shorthand, methods and accessors are not allowed.",
					);
				}
				const keyNode = prop.key;
				const key =
					keyNode.type === "Identifier"
						? keyNode.name
						: keyNode.type === "Literal"
							? String((keyNode as acorn.Literal).value)
							: null;
				if (key === null || RESERVED_KEYS.has(key)) {
					throw new WorkflowCompileError(
						`meta must be a pure literal — invalid or reserved key: ${key ?? String(key)}`,
					);
				}
				out[key] = evaluateMetaLiteral(prop.value, source);
			}
			return out;
		}
		default:
			throw new WorkflowCompileError(
				`meta must be a pure literal — ${node.type} is not allowed. Use only literals, arrays, and plain objects.`,
			);
	}
}

function validateMeta(value: Record<string, unknown>): WorkflowMeta {
	const fail = (msg: string): WorkflowCompileError => new WorkflowCompileError(`Invalid meta: ${msg}`);
	const name = value.name;
	if (typeof name !== "string" || !name.trim()) throw fail("`name` must be a non-empty string.");
	const description = value.description;
	if (typeof description !== "string" || !description.trim())
		throw fail("`description` must be a non-empty string (one line, shown in the approval dialog).");
	const meta: WorkflowMeta = { name: name.trim(), description: description.trim() };
	const title = value.title;
	if (title !== undefined && typeof title !== "string") throw fail("`title` must be a string.");
	const whenToUse = value.whenToUse;
	if (whenToUse !== undefined && typeof whenToUse !== "string") throw fail("`whenToUse` must be a string.");
	if (value.phases !== undefined) {
		const phases = value.phases;
		if (!Array.isArray(phases)) throw fail("`phases` must be an array of { title, detail?, model? }.");
		meta.phases = phases.map((p, i) => {
			if (typeof p !== "object" || p === null) throw fail(`phases[${i}] must be an object.`);
			const entry = p as Record<string, unknown>;
			const phaseTitle = entry.title;
			if (typeof phaseTitle !== "string" || !phaseTitle.trim())
				throw fail(`phases[${i}].title must be a non-empty string.`);
			const phase: { title: string; detail?: string; model?: string } = { title: phaseTitle.trim() };
			const detail = entry.detail;
			if (detail !== undefined && typeof detail !== "string") throw fail(`phases[${i}].detail must be a string.`);
			if (detail !== undefined) phase.detail = detail;
			const model = entry.model;
			if (model !== undefined && typeof model !== "string") throw fail(`phases[${i}].model must be a string.`);
			if (model !== undefined) phase.model = model;
			return phase;
		});
	}
	return meta;
}

/**
 * Parse the meta block and return it plus the raw script body (everything after
 * the export statement).
 */
export function parseMeta(source: string): { meta: WorkflowMeta; body: string; bodyStart: number } {
	if (typeof source !== "string" || source.length === 0) throw new WorkflowCompileError("Workflow script is empty.");
	if (source.length > MAX_SCRIPT_CHARS) {
		throw new WorkflowCompileError(
			`Workflow script exceeds the ${MAX_SCRIPT_CHARS}-character limit (${source.length} characters).`,
		);
	}
	const program = parseScript(source);
	const first = program.body[0];
	if (
		first?.type !== "ExportNamedDeclaration" ||
		!first.declaration ||
		first.declaration.type !== "VariableDeclaration" ||
		first.declaration.kind !== "const" ||
		first.declaration.declarations.length !== 1
	) {
		throw new WorkflowCompileError(
			`Workflow scripts must begin with:\n\nexport const meta = { name: "...", description: "..." }\n\nas the FIRST statement — a pure literal (no variables, calls, or interpolation).`,
		);
	}
	const decl = first.declaration.declarations[0]!;
	if (
		decl.id.type !== "Identifier" ||
		decl.id.name !== "meta" ||
		!decl.init ||
		decl.init.type !== "ObjectExpression"
	) {
		throw new WorkflowCompileError(
			`The first statement must be exactly \`export const meta = {…}\` initialized with an object literal.`,
		);
	}
	const meta = validateMeta(evaluateMetaLiteral(decl.init, source) as Record<string, unknown>);
	const bodyStart = first.end;
	return { meta, body: source.slice(bodyStart), bodyStart };
}

// ---------------------------------------------------------------------------
// Banned syntax + determinism
// ---------------------------------------------------------------------------

const FUNC_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function isAsyncFn(node: acorn.Node): boolean {
	return FUNC_TYPES.has(node.type) && (node as { async?: boolean }).async === true;
}

/** Walk the body AST, rejecting syntax the sandbox cannot host safely. */
export function checkBannedSyntax(program: acorn.Program, source: string): void {
	// The leading `export const meta = {...}` is required — only import/export
	// AFTER the meta statement is banned. Skip it by node identity.
	const first = program.body[0];
	const isMetaExport =
		first?.type === "ExportNamedDeclaration" &&
		first.declaration?.type === "VariableDeclaration" &&
		(first.declaration.declarations[0] as { id?: { name?: string } } | undefined)?.id?.name === "meta";
	walk.full(program, (node) => {
		if (isMetaExport && node === first) return;
		switch (node.type) {
			case "WithStatement":
				throw new WorkflowCompileError("`with` statements are not allowed in workflow scripts.");
			case "ImportExpression":
				throw new WorkflowCompileError("Dynamic import() is not allowed in workflow scripts.");
			case "CallExpression": {
				const callee = (node as acorn.CallExpression).callee;
				if ((callee.type as string) === "Import") {
					throw new WorkflowCompileError("Dynamic import() is not allowed in workflow scripts.");
				}
				break;
			}
			case "ImportDeclaration":
			case "ExportAllDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportNamedDeclaration":
				throw new WorkflowCompileError(
					`import/export statements are not allowed in the workflow body (only the leading \`export const meta\`).\n${caretSnippet(source, node.loc!.start.line, node.loc!.start.column)}`,
				);
			case "VariableDeclaration": {
				const kind = (node as unknown as { kind: string }).kind;
				if (kind === "using" || kind === "await using") {
					throw new WorkflowCompileError(
						"`using` / `await using` declarations are not allowed in workflow scripts.",
					);
				}
				break;
			}
			case "Identifier": {
				const name = (node as acorn.Identifier).name;
				if (name.startsWith("__wRg$")) {
					throw new WorkflowCompileError("Identifiers starting with __wRg$ are reserved by the workflow runtime.");
				}
				break;
			}
		}
	});
}

/**
 * Determinism static check (`rSt`): refuse Date.now / Math.random / argless
 * new Date() / bare Date() — they would corrupt journal-based resume.
 */
export function checkDeterminism(source: string): void {
	const msg =
		"Workflow scripts must be deterministic — Date.now(), Math.random(), and argless new Date() are not available (they would break resume). Pass timestamps in via args; stamp results after the workflow returns; vary agent prompts by index instead of using random().";
	if (/Date\s*\.\s*now/.test(source)) throw new WorkflowCompileError(msg);
	if (/Math\s*\.\s*random/.test(source)) throw new WorkflowCompileError(msg);
	if (/new\s+Date\s*\(\s*\)/.test(source)) throw new WorkflowCompileError(msg);
	if (/(^|[^\w.$])Date\s*\(\s*\)/.test(source)) throw new WorkflowCompileError(msg);
}

// ---------------------------------------------------------------------------
// Await-wrap transform (`Fo`-style __wRg$ wrapping)
// ---------------------------------------------------------------------------

interface Edit {
	start: number;
	end: number;
	text: string;
}

/**
 * Collect source edits that wrap awaited values so every thenable passes
 * through the host realm's Promise.resolve (cross-realm safety + single abort
 * point). Covers: await arguments, `return` values inside async functions,
 * async arrow expression bodies.
 *
 * Overlap rule: when an edit strictly contains another edit (nested awaits),
 * the inner edit wins — the innermost host hop already guarantees the value
 * was host-resolved, and the outer await's native thenable adoption is
 * spec-compliant cross-realm.
 */
export function collectAwaitEdits(program: acorn.Program, source: string): Edit[] {
	const edits: Edit[] = [];
	const ancestors: acorn.Node[] = [];

	const visit = (node: acorn.Node) => {
		if (node.type === "AwaitExpression") {
			const arg = (node as acorn.AwaitExpression).argument;
			edits.push({ start: arg.start, end: arg.end, text: `__wRg$(${source.slice(arg.start, arg.end)})` });
		} else if (node.type === "ReturnStatement") {
			const argument = (node as acorn.ReturnStatement).argument;
			const enclosing = [...ancestors].reverse().find((n) => FUNC_TYPES.has(n.type));
			// Wrap returns inside async functions (the top-level body becomes an async
			// IIFE, but its returns are wrapped via the body-level rewrite below only
			// if not already covered — enclosing === undefined at top level).
			if (argument && enclosing && isAsyncFn(enclosing)) {
				edits.push({
					start: argument.start,
					end: argument.end,
					text: `__wRg$(${source.slice(argument.start, argument.end)})`,
				});
			}
		} else if (node.type === "ArrowFunctionExpression") {
			const arrow = node as acorn.ArrowFunctionExpression;
			if (arrow.async && arrow.body.type !== "BlockStatement") {
				edits.push({
					start: arrow.body.start,
					end: arrow.body.end,
					text: `__wRg$(${source.slice(arrow.body.start, arrow.body.end)})`,
				});
			}
		}

		ancestors.push(node);
		for (const key in node) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const child of value) {
					if (child && typeof child === "object" && typeof (child as acorn.Node).type === "string")
						visit(child as acorn.Node);
				}
			} else if (value && typeof value === "object" && typeof (value as acorn.Node).type === "string") {
				visit(value as acorn.Node);
			}
		}
		ancestors.pop();
	};

	visit(program);

	// Resolve overlaps: drop any edit whose range strictly contains another edit's range.
	const kept = edits.filter(
		(e) =>
			!edits.some((o) => o !== e && o.start >= e.start && o.end <= e.end && (o.start > e.start || o.end < e.end)),
	);
	kept.sort((a, b) => b.start - a.start); // apply back-to-front
	return kept;
}

function applyEdits(source: string, edits: Edit[]): string {
	let out = source;
	for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export function compileWorkflow(source: string): CompiledWorkflow {
	const { meta, body } = parseMeta(source);
	// Re-parse the full program for body walks (already validated by parseMeta).
	const program = parseScript(source);
	checkBannedSyntax(program, source);
	checkDeterminism(source);

	// Edits are collected in full-source coordinates, then shifted into
	// body-relative coordinates for splicing into the extracted body.
	const edits = collectBodyEdits(program, source);

	const transformed = applyEdits(body, edits);
	const iifeSource = `(async () => {\n${transformed}\n})()`;
	let script: vm.Script;
	try {
		script = new vm.Script(iifeSource, { filename: "workflow.js" });
	} catch (err) {
		const e = err as Error;
		throw new WorkflowCompileError(`Failed to compile workflow script: ${e.message}\n${PLAIN_JS_HINT}`);
	}
	return { meta, iifeSource, script };
}

/**
 * Collect await edits for statements after the meta export, expressed in
 * body-relative coordinates.
 */
function collectBodyEdits(program: acorn.Program, source: string): Edit[] {
	const bodyStart = program.body[0]!.end;
	const full = collectAwaitEdits(program, source);
	return full
		.filter((e) => e.start >= bodyStart)
		.map((e) => ({ start: e.start - bodyStart, end: e.end - bodyStart, text: e.text }));
}

/** Re-exported for the sandbox fallback path (same-realm new Function). */
export function compileBodyToIife(source: string): { meta: WorkflowMeta; iifeSource: string } {
	const { meta, iifeSource } = compileWorkflow(source);
	return { meta, iifeSource };
}
