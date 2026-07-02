import { deepFreeze } from "./dsl.js";
import type {
	ActionStateAst,
	ActionUID,
	AgentActionAst,
	AuthoringDiagnostic,
	ChartAst,
	ChartCst,
	ChartSource,
	FinalStateAst,
	GuardRef,
	OnReject,
	OutputSpecAst,
	ParsedChart,
	StateActionAst,
	StateAst,
	UserActionAst,
} from "./types.js";

const RESERVED_SYSTEM_EVENTS = new Set(["FAILED"]);

// Validation is a single pass: unknown input goes straight to a frozen AST plus diagnostics.
// The *Cst types describe only what authors write (DSL factory inputs); ParsedChart.cst is the
// untouched input echoed back, never a reconstructed tree.
export function normalizeChartConfig(input: unknown, source: ChartSource = {}): ParsedChart {
	const diagnostics: AuthoringDiagnostic[] = [];
	const ast = toChartAst(input, diagnostics, source);
	const cst = isRecord(input) ? (input as ChartCst) : undefined;
	if (diagnostics.length > 0 || ast === undefined) {
		return { ok: false, source, ...(cst === undefined ? {} : { cst }), diagnostics };
	}
	if (cst === undefined) {
		return { ok: false, source, diagnostics };
	}
	return { ok: true, source, cst, ast, diagnostics: [] };
}

export function isReservedSystemEvent(eventType: string): boolean {
	return RESERVED_SYSTEM_EVENTS.has(eventType);
}

function toChartAst(input: unknown, diagnostics: AuthoringDiagnostic[], source: ChartSource): ChartAst | undefined {
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
		diagnostics.push(diagnostic("INVALID_INITIAL", "Chart initial must be a non-empty state id.", "/initial", source));
	}
	if (!isRecord(input.states)) {
		diagnostics.push(diagnostic("INVALID_STATES", "Chart states must be an object.", "/states", source));
		return undefined;
	}

	const chartId = typeof id === "string" ? id : "";
	const states: Record<string, StateAst> = {};
	for (const [stateId, stateInput] of Object.entries(input.states)) {
		const state = toStateAst(stateInput, chartId, stateId, `/states/${escapePointer(stateId)}`, diagnostics, source);
		if (state !== undefined) states[stateId] = state;
	}

	if (typeof initial === "string" && !(initial in states)) {
		diagnostics.push(
			diagnostic("UNKNOWN_INITIAL_STATE", `Initial state '${initial}' does not exist.`, "/initial", source),
		);
	}
	for (const [stateId, state] of Object.entries(states)) {
		if (state.kind !== "state") continue;
		for (const [eventType, target] of Object.entries(state.transitions)) {
			if (!(target in states)) {
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
		if (state.after !== undefined && !(state.after.target in states)) {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_AFTER_TARGET",
					`after in state '${stateId}' targets unknown state '${state.after.target}'.`,
					`/states/${escapePointer(stateId)}/after/target`,
					source,
				),
			);
		}
	}

	if (diagnostics.length > 0) return undefined;
	return deepFreeze({
		kind: "chart",
		id: chartId,
		initial: typeof initial === "string" ? initial : "",
		states,
	});
}

function toStateAst(
	input: unknown,
	chartId: string,
	stateId: string,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): StateAst | undefined {
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
		return deepFreeze({ kind: "final", id: stateId } satisfies FinalStateAst);
	}

	if ("action" in input) {
		const action = toStateActionAst(input.action, chartId, stateId, `${path}/action`, diagnostics, source);
		const transitions = toTransitionMap(input.transitions, `${path}/transitions`, diagnostics, source);
		const after = toAfter(input.after, `${path}/after`, diagnostics, source);
		const validate = toGuardRef(input.validate, `${path}/validate`, diagnostics, source);
		let onReject: OnReject | undefined;
		if (input.onReject !== undefined) {
			if (input.onReject !== "resume" && input.onReject !== "restart") {
				diagnostics.push(
					diagnostic("INVALID_ON_REJECT", "onReject must be 'resume' or 'restart'.", `${path}/onReject`, source),
				);
			} else if (input.validate === undefined) {
				diagnostics.push(diagnostic("INVALID_ON_REJECT", "onReject requires validate.", `${path}/onReject`, source));
			} else {
				onReject = input.onReject;
			}
		}
		if (action === undefined) return undefined;
		return deepFreeze({
			kind: "state",
			id: stateId,
			action,
			transitions: transitions ?? {},
			...(after === undefined ? {} : { after }),
			...(validate === undefined ? {} : { validate, onReject: onReject ?? "resume" }),
		} satisfies ActionStateAst);
	}

	diagnostics.push(diagnostic("MISSING_ACTION", "Non-final state must define exactly one action.", path, source));
	return undefined;
}

function toStateActionAst(
	input: unknown,
	chartId: string,
	stateId: string,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): StateActionAst | undefined {
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_ACTION", "State action must be an object.", path, source));
		return undefined;
	}
	switch (input.kind) {
		case "agent": {
			if (typeof input.name !== "string" || input.name.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_AGENT_NAME", "Agent action name must be a string.", `${path}/name`, source),
				);
			}
			const output = toOutputSpecAst(input.output, `${path}/output`, diagnostics, source);
			const uid: ActionUID = { chart: chartId, state: stateId, action: "agent" };
			return deepFreeze({
				kind: "agent",
				uid,
				name: typeof input.name === "string" ? input.name : "",
				...(output === undefined ? {} : { output }),
			} satisfies AgentActionAst);
		}
		case "user": {
			if (typeof input.prompt !== "string") {
				diagnostics.push(diagnostic("INVALID_USER_PROMPT", "User prompt must be a string.", `${path}/prompt`, source));
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
			const output = toOutputSpecAst(input.output, `${path}/output`, diagnostics, source);
			const uid: ActionUID = { chart: chartId, state: stateId, action: "user" };
			return deepFreeze({
				kind: "user",
				uid,
				prompt: typeof input.prompt === "string" ? input.prompt : "",
				options: options.filter((option): option is string => typeof option === "string"),
				...(output === undefined ? {} : { output }),
			} satisfies UserActionAst);
		}
		default:
			diagnostics.push(
				diagnostic("INVALID_ACTION_KIND", "Action kind must be 'agent' or 'user'.", `${path}/kind`, source),
			);
			return undefined;
	}
}

function toOutputSpecAst(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): OutputSpecAst | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_OUTPUT_SPEC", "Output spec must be an object.", path, source));
		return undefined;
	}
	switch (input.kind) {
		case "jsonSchema":
			if (!isRecord(input.schema)) {
				diagnostics.push(
					diagnostic(
						"INVALID_JSON_SCHEMA",
						"JSON Schema output must contain an object schema.",
						`${path}/schema`,
						source,
					),
				);
				return undefined;
			}
			return { kind: "jsonSchema", schema: { ...input.schema } };
		case "schemaRef":
			if (typeof input.name !== "string" || input.name.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_SCHEMA_REF", "Schema ref name must be a non-empty string.", `${path}/name`, source),
				);
				return undefined;
			}
			return { kind: "schemaRef", name: input.name };
		case "tsImport":
			if (typeof input.module !== "string" || input.module.length === 0) {
				diagnostics.push(
					diagnostic(
						"INVALID_SCHEMA_IMPORT",
						"TS import schema module must be a non-empty string.",
						`${path}/module`,
						source,
					),
				);
			}
			if (typeof input.export !== "string" || input.export.length === 0) {
				diagnostics.push(
					diagnostic(
						"INVALID_SCHEMA_IMPORT",
						"TS import schema export must be a non-empty string.",
						`${path}/export`,
						source,
					),
				);
			}
			return {
				kind: "tsImport",
				module: typeof input.module === "string" ? input.module : "",
				export: typeof input.export === "string" ? input.export : "",
			};
		default:
			diagnostics.push(
				diagnostic(
					"INVALID_OUTPUT_SPEC",
					"Output spec kind must be 'jsonSchema', 'schemaRef', or 'tsImport'.",
					`${path}/kind`,
					source,
				),
			);
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
			diagnostics.push(
				diagnostic(
					"INVALID_TRANSITION_TARGET",
					"Transition target must be a non-empty state id.",
					`${path}/${escapePointer(eventType)}`,
					source,
				),
			);
			continue;
		}
		transitions[eventType] = target;
	}
	return transitions;
}

function toAfter(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): { delayMs: number; target: string } | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_AFTER", "after must be an object with delayMs and target.", path, source));
		return undefined;
	}
	if (typeof input.delayMs !== "number" || !Number.isFinite(input.delayMs) || input.delayMs <= 0) {
		diagnostics.push(
			diagnostic("INVALID_AFTER", "after.delayMs must be a positive number.", `${path}/delayMs`, source),
		);
		return undefined;
	}
	if (typeof input.target !== "string" || input.target.length === 0) {
		diagnostics.push(
			diagnostic("INVALID_AFTER", "after.target must be a non-empty state id.", `${path}/target`, source),
		);
		return undefined;
	}
	return { delayMs: input.delayMs, target: input.target };
}

function toGuardRef(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): GuardRef | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(
			diagnostic("INVALID_GUARD", "Guard must be a tsImport or script reference, not an inline value.", path, source),
		);
		return undefined;
	}
	switch (input.kind) {
		case "tsImport":
			if (typeof input.module !== "string" || input.module.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_GUARD", "Guard tsImport module must be a non-empty string.", `${path}/module`, source),
				);
				return undefined;
			}
			if (typeof input.export !== "string" || input.export.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_GUARD", "Guard tsImport export must be a non-empty string.", `${path}/export`, source),
				);
				return undefined;
			}
			return { kind: "tsImport", module: input.module, export: input.export };
		case "script": {
			if (typeof input.command !== "string" || input.command.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_GUARD", "Guard script command must be a non-empty string.", `${path}/command`, source),
				);
				return undefined;
			}
			const args = Array.isArray(input.args) ? input.args : [];
			if (!args.every((arg): arg is string => typeof arg === "string")) {
				diagnostics.push(diagnostic("INVALID_GUARD", "Guard script args must be strings.", `${path}/args`, source));
				return undefined;
			}
			return { kind: "script", command: input.command, ...(args.length === 0 ? {} : { args }) };
		}
		default:
			diagnostics.push(
				diagnostic("INVALID_GUARD", "Guard kind must be 'tsImport' or 'script'.", `${path}/kind`, source),
			);
			return undefined;
	}
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
