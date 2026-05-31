import { deepFreeze } from "./dsl.js";
import type {
	ActionStateAst,
	ActionStateCst,
	AgentActionAst,
	AgentActionCst,
	AuthoringDiagnostic,
	ChartAst,
	ChartCst,
	ChartInput,
	ChartSource,
	FinalStateAst,
	FinalStateCst,
	JsonSchemaOutputAst,
	JsonSchemaOutputCst,
	OutputSpecAst,
	OutputSpecCst,
	InputMapper,
	ParsedChart,
	ScriptActionAst,
	ScriptActionCst,
	StateActionAst,
	StateActionCst,
	StateAst,
	StateCst,
	StateInput,
	TsImportSchemaRefCst,
	UserActionAst,
	UserActionCst,
} from "./types.js";

const RESERVED_SYSTEM_EVENTS = new Set(["FAILED"]);

export function normalizeChartConfig<TInput = unknown>(
	input: unknown,
	source: ChartSource = {},
): ParsedChart<TInput> {
	const diagnostics: AuthoringDiagnostic[] = [];
	const cst = toChartCst<TInput>(input, diagnostics, source);
	if (cst === undefined) {
		return { ok: false, source, diagnostics };
	}

	const ast = normalizeChartCst(cst, diagnostics, source);
	if (diagnostics.length > 0 || ast === undefined) {
		return { ok: false, source, cst, diagnostics };
	}

	return { ok: true, source, cst, ast, diagnostics: [] };
}

export function isReservedSystemEvent(eventType: string): boolean {
	return RESERVED_SYSTEM_EVENTS.has(eventType);
}

function toChartCst<TInput>(
	input: unknown,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): ChartCst<TInput> | undefined {
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_CHART", "Chart export must be an object.", "", source));
		return undefined;
	}
	if ("kind" in input && input.kind !== "chart") {
		diagnostics.push(diagnostic("INVALID_CHART_KIND", "Chart kind must be 'chart'.", "/kind", source));
	}
	const id = input.id;
	if (typeof id !== "string" || id.length === 0) {
		diagnostics.push(diagnostic("INVALID_CHART_ID", "Chart id must be a non-empty string.", "/id", source));
	}
	const initial = input.initial;
	if (typeof initial !== "string" || initial.length === 0) {
		diagnostics.push(
			diagnostic("INVALID_INITIAL", "Chart initial must be a non-empty state id.", "/initial", source),
		);
	}
	if (!isRecord(input.states)) {
		diagnostics.push(diagnostic("INVALID_STATES", "Chart states must be an object.", "/states", source));
		return undefined;
	}

	const states: Record<string, StateCst<TInput>> = {};
	for (const [stateId, stateInput] of Object.entries(input.states)) {
		const state = toStateCst<TInput>(stateInput, `/states/${escapePointer(stateId)}`, diagnostics, source);
		if (state !== undefined) states[stateId] = state;
	}

	return deepFreeze({
		kind: "chart",
		id: typeof id === "string" ? id : "",
		initial: typeof initial === "string" ? initial : "",
		states,
	});
}

function toStateCst<TInput>(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): StateCst<TInput> | undefined {
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_STATE", "State must be an object.", path, source));
		return undefined;
	}

	if (input.kind === "final" || input.final === true) {
		if ("action" in input) {
			diagnostics.push(
				diagnostic("INVALID_FINAL_STATE", "Final state must not define an action.", `${path}/action`, source),
			);
		}
		return deepFreeze({ kind: "final" });
	}

	if ("action" in input) {
		const action = toStateActionCst<TInput>(input.action, `${path}/action`, diagnostics, source);
		const transitions = toTransitionMap(input.transitions, `${path}/transitions`, diagnostics, source);
		if (action === undefined) return undefined;
		return deepFreeze({
			kind: "state",
			action,
			...(transitions === undefined ? {} : { transitions }),
		});
	}

	diagnostics.push(diagnostic("MISSING_ACTION", "Non-final state must define exactly one action.", path, source));
	return undefined;
}

function toStateActionCst<TInput>(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): StateActionCst<TInput> | undefined {
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_ACTION", "State action must be an object.", path, source));
		return undefined;
	}
	switch (input.kind) {
		case "agent": {
			if (typeof input.name !== "string" || input.name.length === 0) {
				diagnostics.push(diagnostic("INVALID_AGENT_NAME", "Agent action name must be a string.", `${path}/name`, source));
			}
			const output = toOutputSpec(input.output, `${path}/output`, diagnostics, source);
			const action: AgentActionCst<TInput> = {
				kind: "agent",
				name: typeof input.name === "string" ? input.name : "",
			};
			if (typeof input.input === "function") action.input = input.input as InputMapper<TInput>;
			if (output !== undefined) action.output = output;
			return deepFreeze(action);
		}
		case "script": {
			if (typeof input.command !== "string" && typeof input.command !== "function") {
				diagnostics.push(
					diagnostic("INVALID_SCRIPT_COMMAND", "Script command must be a string or mapper.", `${path}/command`, source),
				);
			}
			const output = toOutputSpec(input.output, `${path}/output`, diagnostics, source);
			return deepFreeze({
				kind: "script",
				command: (typeof input.command === "string" || typeof input.command === "function" ? input.command : "") as ScriptActionCst<TInput>["command"],
				...(output === undefined ? {} : { output }),
			});
		}
		case "user": {
			if (typeof input.prompt !== "string" && typeof input.prompt !== "function") {
				diagnostics.push(
					diagnostic("INVALID_USER_PROMPT", "User prompt must be a string or mapper.", `${path}/prompt`, source),
				);
			}
			const options = Array.isArray(input.options) ? input.options : [];
			for (const [index, option] of options.entries()) {
				if (typeof option !== "string") {
					diagnostics.push(
						diagnostic("INVALID_USER_OPTION", "User options must be strings.", `${path}/options/${index}`, source),
					);
				} else if (isReservedSystemEvent(option)) {
					diagnostics.push(
						diagnostic(
							"RESERVED_EVENT_EMIT",
							`User option '${option}' is reserved for system events and cannot be emitted by actions.`,
							`${path}/options/${index}`,
							source,
						),
					);
				}
			}
			const output = toOutputSpec(input.output, `${path}/output`, diagnostics, source);
			return deepFreeze({
				kind: "user",
				prompt: (typeof input.prompt === "string" || typeof input.prompt === "function" ? input.prompt : "") as UserActionCst<TInput>["prompt"],
				options: options.filter((option): option is string => typeof option === "string"),
				...(output === undefined ? {} : { output }),
			});
		}
		default:
			diagnostics.push(diagnostic("INVALID_ACTION_KIND", "Action kind must be 'agent', 'script', or 'user'.", `${path}/kind`, source));
			return undefined;
	}
}

function toOutputSpec(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): OutputSpecCst | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_OUTPUT_SPEC", "Output spec must be an object.", path, source));
		return undefined;
	}
	switch (input.kind) {
		case "jsonSchema":
			if (!isRecord(input.schema)) {
				diagnostics.push(diagnostic("INVALID_JSON_SCHEMA", "JSON Schema output must contain an object schema.", `${path}/schema`, source));
				return undefined;
			}
			return deepFreeze({ kind: "jsonSchema", schema: { ...input.schema } });
		case "schemaRef":
			if (typeof input.name !== "string" || input.name.length === 0) {
				diagnostics.push(diagnostic("INVALID_SCHEMA_REF", "Schema ref name must be a non-empty string.", `${path}/name`, source));
				return undefined;
			}
			return deepFreeze({ kind: "schemaRef", name: input.name });
		case "tsImport":
			if (typeof input.module !== "string" || input.module.length === 0) {
				diagnostics.push(diagnostic("INVALID_SCHEMA_IMPORT", "TS import schema module must be a non-empty string.", `${path}/module`, source));
			}
			if (typeof input.export !== "string" || input.export.length === 0) {
				diagnostics.push(diagnostic("INVALID_SCHEMA_IMPORT", "TS import schema export must be a non-empty string.", `${path}/export`, source));
			}
			return deepFreeze({
				kind: "tsImport",
				module: typeof input.module === "string" ? input.module : "",
				export: typeof input.export === "string" ? input.export : "",
			});
		default:
			diagnostics.push(diagnostic("INVALID_OUTPUT_SPEC", "Output spec kind must be 'jsonSchema', 'schemaRef', or 'tsImport'.", `${path}/kind`, source));
			return undefined;
	}
}

function toTransitionMap(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): Record<string, string> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_TRANSITIONS", "Transitions must be an object map.", path, source));
		return undefined;
	}
	const transitions: Record<string, string> = {};
	for (const [eventType, target] of Object.entries(input)) {
		if (typeof target !== "string" || target.length === 0) {
			diagnostics.push(diagnostic("INVALID_TRANSITION_TARGET", "Transition target must be a non-empty state id.", `${path}/${escapePointer(eventType)}`, source));
			continue;
		}
		transitions[eventType] = target;
	}
	return deepFreeze(transitions);
}

function normalizeChartCst<TInput>(
	cst: ChartCst<TInput>,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): ChartAst<TInput> | undefined {
	if (!(cst.initial in cst.states)) {
		diagnostics.push(
			diagnostic("UNKNOWN_INITIAL_STATE", `Initial state '${cst.initial}' does not exist.`, "/initial", source),
		);
	}
	const states: Record<string, StateAst<TInput>> = {};
	for (const [stateId, state] of Object.entries(cst.states)) {
		states[stateId] = normalizeStateAst(stateId, state, diagnostics, source);
	}
	const stateIds = new Set(Object.keys(cst.states));
	for (const [stateId, state] of Object.entries(cst.states)) {
		if (state.kind !== "state") continue;
		for (const [eventType, target] of Object.entries(state.transitions ?? {})) {
			if (!stateIds.has(target)) {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_TRANSITION_TARGET",
						`Transition '${eventType}' in state '${stateId}' targets unknown state '${target}'.`,
						`/states/${escapePointer(stateId)}/transitions/${escapePointer(eventType)}`,
						source,
					),
				);
			}
		}
	}
	if (diagnostics.length > 0) return undefined;
	return deepFreeze({ kind: "chart", id: cst.id, initial: cst.initial, states });
}

function normalizeStateAst<TInput>(
	stateId: string,
	state: StateCst<TInput>,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): StateAst<TInput> {
	if (state.kind === "final") {
		return deepFreeze({ kind: "final", id: stateId } satisfies FinalStateAst);
	}
	return deepFreeze({
		kind: "state",
		id: stateId,
		action: normalizeActionAst(state.action, diagnostics, source),
		transitions: { ...(state.transitions ?? {}) },
	} satisfies ActionStateAst<TInput>);
}

function normalizeActionAst<TInput>(
	action: StateActionCst<TInput>,
	_diagnostics: AuthoringDiagnostic[],
	_source: ChartSource,
): StateActionAst<TInput> {
	return deepFreeze(action as StateActionAst<TInput>);
}

function diagnostic(code: string, message: string, path: string, source: ChartSource): AuthoringDiagnostic {
	return { code, message, ...(path ? { path } : {}), ...(Object.keys(source).length > 0 ? { source } : {}) };
}

function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
