import type {
	AgentActionCst,
	ChartCst,
	CompoundStateCst,
	FinalStateCst,
	GuardRef,
	ArtifactCst,
	ArtifactOfCst,
	InputRef,
	JsonSchema,
	JsonSchemaOutputCst,
	OutputSpecCst,
	ParallelStateCst,
	SchemaRefCst,
	ScriptActionCst,
	Templatable,
	TemplateCst,
	TsImportSchemaRefCst,
	UserActionCst,
} from "./types.js";

export function chart(input: ChartCst): ChartCst {
	return input;
}

export const createChart = chart;

export function final(): FinalStateCst {
	return { kind: "final" };
}

export function compound(options: Omit<CompoundStateCst, "kind">): CompoundStateCst {
	return { kind: "compound", ...options };
}

export function parallel(options: Omit<ParallelStateCst, "kind">): ParallelStateCst {
	return { kind: "parallel", ...options };
}

export function agent(name: string, options: Omit<AgentActionCst, "kind" | "name"> = {}): AgentActionCst {
	return { kind: "agent", name, ...options };
}

export function user(options: Omit<UserActionCst, "kind">): UserActionCst {
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

export function result(state: string, path?: string): InputRef {
	return { kind: "result", state, ...(path === undefined ? {} : { path }) };
}

// A deliverable file with an optional content shape — see ArtifactCst.
export function artifact(path: Templatable, shape?: OutputSpecCst): ArtifactCst {
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

export function tsImport(module: string, exportName: string): GuardRef {
	return { kind: "tsImport", module, export: exportName };
}

// Doubles as a guard (validate: script(...)) and as a command action (action: script(...)) —
// the position decides. Parameters flow through env templates; command/args stay static.
export function script(
	command: string,
	args?: readonly string[],
	opts: Omit<ScriptActionCst, "kind" | "command" | "args"> = {},
): ScriptActionCst {
	return { kind: "script", command, ...(args === undefined ? {} : { args }), ...opts };
}

export function jsonSchema(schema: JsonSchema): JsonSchemaOutputCst {
	return { kind: "jsonSchema", schema };
}

export function schemaRef(name: string): SchemaRefCst {
	return { kind: "schemaRef", name };
}

export function tsImportSchema(module: string, exportName: string): TsImportSchemaRefCst {
	return { kind: "tsImport", module, export: exportName };
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

export type { OutputSpecCst } from "./types.js";
