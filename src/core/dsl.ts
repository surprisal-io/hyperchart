import type {
	AgentActionCst,
	ChartCst,
	FinalStateCst,
	JsonSchema,
	JsonSchemaOutputCst,
	OutputSpecCst,
	SchemaRefCst,
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

export function agent(name: string, options: Omit<AgentActionCst, "kind" | "name"> = {}): AgentActionCst {
	return { kind: "agent", name, ...options };
}

export function user(options: Omit<UserActionCst, "kind">): UserActionCst {
	return { kind: "user", ...options };
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
