import type {
	AgentActionCst,
	ChartCst,
	CompoundStateCst,
	FinalStateCst,
	GuardRef,
	InputRef,
	JsonSchema,
	JsonSchemaOutputCst,
	ParallelStateCst,
	SchemaRefCst,
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

// Tagged template for parameter values: t`Report on ${arg("topic")} using ${result("plan")}`.
// Evaluates to plain data — the machine renders it right before dispatch.
export function t(strings: TemplateStringsArray, ...refs: InputRef[]): TemplateCst {
	return { kind: "template", strings: [...strings], refs };
}

export function arg(name: string): InputRef {
	return { kind: "arg", name };
}

export function result(state: string, path?: string): InputRef {
	return { kind: "result", state, ...(path === undefined ? {} : { path }) };
}

export function tsImport(module: string, exportName: string): GuardRef {
	return { kind: "tsImport", module, export: exportName };
}

export function script(command: string, args?: readonly string[]): GuardRef {
	return { kind: "script", command, ...(args === undefined ? {} : { args }) };
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
