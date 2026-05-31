import type {
	AgentActionCst,
	ChartCst,
	ChartInput,
	JsonSchema,
	JsonSchemaOutputCst,
	OutputSpecCst,
	SchemaRefCst,
	ScriptActionCst,
	StateActionCst,
	StateCst,
	StateInput,
	StateResult,
	TsImportSchemaRefCst,
	UserActionCst,
} from "./types.js";

export function chart<TInput = unknown>(input: ChartInput<TInput>): ChartCst<TInput> {
	const states: Record<string, StateCst<TInput>> = {};
	for (const [id, state] of Object.entries(input.states)) {
		states[id] = normalizeStateInput(state);
	}
	return deepFreeze({
		kind: "chart",
		id: input.id,
		initial: input.initial,
		states,
	});
}

export const createChart = chart;

export function final(): StateCst {
	return deepFreeze({ kind: "final" });
}

export function agent<TInput = unknown>(
	name: string,
	options: Omit<AgentActionCst<TInput>, "kind" | "name"> = {},
): AgentActionCst<TInput> {
	return deepFreeze({ kind: "agent", name, ...options });
}

export function script<TInput = unknown>(
	command: ScriptActionCst<TInput>["command"],
	options: Omit<ScriptActionCst<TInput>, "kind" | "command"> = {},
): ScriptActionCst<TInput> {
	return deepFreeze({ kind: "script", command, ...options });
}

export function user<TInput = unknown>(options: Omit<UserActionCst<TInput>, "kind">): UserActionCst<TInput> {
	return deepFreeze({ kind: "user", ...options });
}

export function jsonSchema(schema: JsonSchema): JsonSchemaOutputCst {
	return deepFreeze({ kind: "jsonSchema", schema });
}

export function schemaRef(name: string): SchemaRefCst {
	return deepFreeze({ kind: "schemaRef", name });
}

export function tsImportSchema(module: string, exportName: string): TsImportSchemaRefCst {
	return deepFreeze({ kind: "tsImport", module, export: exportName });
}

function normalizeStateInput<TInput>(state: StateInput<TInput>): StateCst<TInput> {
	if (isRecord(state) && "kind" in state && state.kind === "final") {
		return { kind: "final" };
	}
	if (isRecord(state) && "final" in state && state.final === true) {
		return { kind: "final" };
	}
	if (isRecord(state) && "action" in state) {
		return {
			kind: "state",
			action: state.action as StateActionCst<TInput>,
			...(isRecord(state.transitions) ? { transitions: { ...state.transitions } } : {}),
		};
	}
	return state as unknown as StateCst<TInput>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { StateResult, OutputSpecCst } from "./types.js";
