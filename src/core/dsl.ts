import type {
	AgentActionCst,
	ChartCst,
	CompoundStateCst,
	EventBindingCst,
	FinalStateCst,
	GuardRef,
	ArtifactCst,
	ArtifactOfCst,
	JoinArtifactOfCst,
	InputRef,
	MapStateCst,
	SchemaCst,
	ParallelStateCst,
	ScriptActionCst,
	Templatable,
	TemplateCst,
	UserActionCst,
} from "./types.js";

export function chart(input: ChartCst): ChartCst {
	return input;
}

export const createChart = chart;

export function final(): FinalStateCst {
	return { kind: "final" };
}

export function compound<const O extends Omit<CompoundStateCst, "kind">>(options: O): { kind: "compound" } & O {
	return { kind: "compound", ...options };
}

export function parallel<const O extends Omit<ParallelStateCst, "kind">>(options: O): { kind: "parallel" } & O {
	return { kind: "parallel", ...options };
}

export function map<const O extends Omit<MapStateCst, "kind">>(options: O): { kind: "map" } & O {
	return { kind: "map", ...options };
}

// Const type parameters throughout the DSL: the literal types of options (zod replies, artifact
// shapes, nested states) survive into the chart literal, so the typed layer can extract the
// registry from the definition itself.
export function agent<const O extends Omit<AgentActionCst, "kind" | "name">>(
	name: string,
	options: O = {} as O,
): { kind: "agent"; name: string } & O {
	return { kind: "agent", name, ...options };
}

export function user<const O extends Omit<UserActionCst, "kind">>(options: O): { kind: "user" } & O {
	return { kind: "user", ...options };
}

// Tagged template for parameter values: t`Report on ${arg("topic")} using ${result("plan", "dir")}`.
// Evaluates to plain data — the machine renders it right before dispatch. Ref interpolations
// must resolve to primitives (a ref known to hold an object is embedded explicitly via
// json(ref)); plain primitive interpolations are build-time constants and fold into the strings.
export function t(
	strings: TemplateStringsArray,
	...values: (InputRef<string | number | boolean> | string | number | boolean)[]
): TemplateCst {
	const parts: string[] = [strings[0] ?? ""];
	const refs: InputRef[] = [];
	values.forEach((value, index) => {
		const next = strings[index + 1] ?? "";
		if (typeof value === "object") {
			refs.push(value);
			parts.push(next);
		} else {
			parts[parts.length - 1] += String(value) + next;
		}
	});
	return { kind: "template", strings: parts, refs };
}

// Marks a ref whose value is embedded as JSON text — the only way an object enters a template,
// both in the types (t() rejects object-typed refs) and at runtime (the renderer throws on a
// non-primitive value without this mark).
export function json<V>(ref: InputRef<V>): InputRef<string> {
	return { ...ref, json: true } as InputRef<string>;
}

export function arg(name: string): InputRef {
	return { kind: "arg", name };
}

export function event(path?: string): EventBindingCst {
	return { kind: "event", ...(path === undefined ? {} : { path }) };
}

export function input(name: string, path?: string): InputRef {
	return { kind: "input", name, ...(path === undefined ? {} : { path }) };
}

export function visit(state?: string): InputRef<number> {
	return { kind: "visit", ...(state === undefined ? {} : { state }) };
}

// The instance key of the nearest enclosing map.
export function key(): InputRef<string> {
	return { kind: "key" };
}

// The spawn-pinned item of the nearest enclosing map instance, optionally a dot-path into it.
export function item(path?: string): InputRef {
	return { kind: "item", ...(path === undefined ? {} : { path }) };
}

export function result(state: string, path?: string): InputRef {
	return { kind: "result", state, ...(path === undefined ? {} : { path }) };
}

// A deliverable file with an optional content shape — see ArtifactCst.
export function artifact<const P extends Templatable>(path: P): { kind: "artifact"; path: P };
export function artifact<const P extends Templatable, const S extends SchemaCst>(
	path: P,
	shape: S,
): { kind: "artifact"; path: P; shape: S };
export function artifact(path: Templatable, shape?: SchemaCst): ArtifactCst {
	return { kind: "artifact", path, ...(shape === undefined ? {} : { shape }) };
}

// Read an artifact another state declared: path and content shape come from the producer.
// `artifact` names which one (omit when the producer declares exactly one); `select` narrows the
// read to a dot-path field of the file's content.
export function artifactOf(state: string, opts: { artifact?: string; select?: string } = {}): ArtifactOfCst {
	return {
		kind: "artifactOf",
		state,
		...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
		...(opts.select === undefined ? {} : { select: opts.select }),
	};
}

// A read of the named artifact of EVERY instance of the map enclosing `state` (a template
// path): agents get one file per instance, scripts a JSON array of paths.
export function joinArtifactOf(state: string, opts: { artifact?: string } = {}): JoinArtifactOfCst {
	return { kind: "joinArtifactOf", state, ...(opts.artifact === undefined ? {} : { artifact: opts.artifact }) };
}

export function tsImport(module: string, exportName: string): GuardRef {
	return { kind: "tsImport", module, export: exportName };
}

// Doubles as a guard (validate: script(...)) and as a command action (action: script(...)) —
// the position decides. Parameters flow through env templates; command/args stay static.
export function script<const O extends Omit<ScriptActionCst, "kind" | "command" | "args">>(
	command: string,
	args?: readonly string[],
	opts: O = {} as O,
): { kind: "script"; command: string; args?: readonly string[] } & O {
	return { kind: "script", command, ...(args === undefined ? {} : { args }), ...opts };
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return value;
	}
	const object = value as object;
	if (seen.has(object)) return value;
	seen.add(object);
	for (const property of Reflect.ownKeys(object)) {
		const child = (object as Record<PropertyKey, unknown>)[property];
		deepFreeze(child, seen);
	}
	return Object.freeze(value);
}

export type { SchemaCst } from "./types.js";
