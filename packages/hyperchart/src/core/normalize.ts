import { z } from "zod";
import { deepFreeze } from "./dsl.js";
import { runtimeContractMetadata } from "./schema_contract.js";
import { SchemaRegistry } from "./schema_registry.js";
import type {
	ActionStateAst,
	ActionUID,
	AgentActionAst,
	AuthoringDiagnostic,
	ChartAst,
	ChartCst,
	ChartSource,
	ArtifactAst,
	CompoundStateAst,
	EventBindingAst,
	ArtifactOfAst,
	JoinArtifactOfAst,
	FinalStateAst,
	GuardRefAst,
	InputRef,
	MapStateAst,
	OnReject,
	OnReenterAst,
	SchemaAst,
	ParallelStateAst,
	ParsedChart,
	RegionStateAst,
	ScriptActionAst,
	StateActionAst,
	StateAst,
	StateId,
	StatePath,
	TemplateAst,
	TerminalNotificationAst,
	TransitionAst,
	UserActionAst,
} from "./types.js";

const RESERVED_SYSTEM_EVENTS = new Set(["FAILED"]);

// "." separates path segments, ":" separates effect id segments, "#" separates a map instance
// key from its state id.
const STATE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Validation is a single pass: unknown input goes straight to a frozen AST plus diagnostics.
// The *Cst types describe only what authors write (DSL factory inputs); ParsedChart.cst is the
// untouched input echoed back, never a reconstructed tree.
export function normalizeChartConfig(input: unknown, source: ChartSource = {}): ParsedChart {
	const diagnostics: AuthoringDiagnostic[] = [];
	const schemaRegistry = new SchemaRegistry();
	const ast = toChartAst(input, diagnostics, source, schemaRegistry);
	const cst = isRecord(input) ? (input as ChartCst) : undefined;
	if (diagnostics.length > 0 || ast === undefined) {
		return {
			ok: false,
			source,
			...(cst === undefined ? {} : { cst }),
			diagnostics,
		};
	}
	if (cst === undefined) {
		return { ok: false, source, diagnostics };
	}
	return { ok: true, source, cst, ast, schemaRegistry, diagnostics: [] };
}

export function isReservedSystemEvent(eventType: string): boolean {
	return RESERVED_SYSTEM_EVENTS.has(eventType);
}

function toChartAst(
	input: unknown,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
): ChartAst | undefined {
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
	const states: Record<StatePath, StateAst> = {};
	for (const [stateId, stateInput] of Object.entries(input.states)) {
		collectState(
			stateInput,
			chartId,
			stateId,
			undefined,
			`/states/${escapePointer(stateId)}`,
			states,
			diagnostics,
			source,
			schemaRegistry,
		);
	}

	if (typeof initial === "string" && !(initial in states)) {
		diagnostics.push(
			diagnostic("UNKNOWN_INITIAL_STATE", `Initial state '${initial}' does not exist.`, "/initial", source),
		);
	}
	validateTargets(states, diagnostics, source);
	const beforeCycles = diagnostics.length;
	validateEnterCycles(states, diagnostics, source);
	// Input and domination analysis walk the same enter-resolution chain (inputEntryTargets) and
	// would recurse without bound on a cyclic one — a found cycle makes them unrunnable.
	if (diagnostics.length === beforeCycles) {
		validateInputs(states, typeof initial === "string" ? initial : "", diagnostics, source);
		validateDominatedRefs(states, typeof initial === "string" ? initial : "", diagnostics, source);
	}

	if (diagnostics.length > 0) return undefined;
	return deepFreeze({
		kind: "chart",
		id: chartId,
		initial: typeof initial === "string" ? initial : "",
		states,
	});
}

// Builds the node at its absolute path and recurses into compound children — the AST stays a
// flat path-keyed map, nesting lives in `parent` links. Direct children of a parallel are
// collected with the "region" role: authored as compounds, they become region nodes.
function collectState(
	input: unknown,
	chartId: string,
	localId: string,
	parentPath: StatePath | undefined,
	pointer: string,
	states: Record<StatePath, StateAst>,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
	role: "state" | "region" = "state",
): void {
	if (!STATE_ID_PATTERN.test(localId)) {
		diagnostics.push(
			diagnostic(
				"INVALID_STATE_ID",
				`State id '${localId}' must match [A-Za-z0-9_-]+ ('.', ':' and '#' are reserved).`,
				pointer,
				source,
			),
		);
		return;
	}
	const path = parentPath === undefined ? localId : `${parentPath}.${localId}`;
	const parent = parentPath === undefined ? {} : { parent: parentPath };
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_STATE", "State must be an object.", pointer, source));
		return;
	}

	if (input.kind === "final" || input.final === true) {
		if (role === "region") {
			diagnostics.push(diagnostic("INVALID_REGION", `Region '${path}' must be a compound state.`, pointer, source));
			return;
		}
		if ("action" in input) {
			diagnostics.push(
				diagnostic("INVALID_FINAL_STATE", "Final state must not define an action.", `${pointer}/action`, source),
			);
		}
		const outcome = input.outcome === "failed" ? "failed" : "complete";
		if (input.outcome !== undefined && input.outcome !== "complete" && input.outcome !== "failed") {
			diagnostics.push(diagnostic("INVALID_FINAL_OUTCOME", "Final outcome must be 'complete' or 'failed'.", `${pointer}/outcome`, source));
		}
		const notify = toTerminalNotification(input.notify, `${pointer}/notify`, diagnostics, source);
		states[path] = deepFreeze({
			kind: "final",
			id: localId,
			...parent,
			outcome,
			...(notify === undefined ? {} : { notify }),
		} satisfies FinalStateAst);
		return;
	}

	if (input.kind === "parallel") {
		if (role === "region") {
			diagnostics.push(diagnostic("INVALID_REGION", `Region '${path}' must be a compound state.`, pointer, source));
			return;
		}
		if (!isRecord(input.states)) {
			diagnostics.push(diagnostic("INVALID_STATES", "Parallel states must be an object.", `${pointer}/states`, source));
			return;
		}
		const transitions = toTransitionMap(input.transitions, `${pointer}/transitions`, diagnostics, source);
		const onDone = toOnDone(input.onDone, `${pointer}/onDone`, diagnostics, source);
		if (onDone === undefined) {
			diagnostics.push(diagnostic("MISSING_ON_DONE", `Parallel '${path}' must declare onDone.`, pointer, source));
		}
		const regions = Object.keys(input.states);
		for (const [childId, childInput] of Object.entries(input.states)) {
			collectState(
				childInput,
				chartId,
				childId,
				path,
				`${pointer}/states/${escapePointer(childId)}`,
				states,
				diagnostics,
				source,
				schemaRegistry,
				"region",
			);
		}
		states[path] = deepFreeze({
			kind: "parallel",
			id: localId,
			...parent,
			regions,
			transitions: transitions ?? {},
			onDone: onDone ?? "",
		} satisfies ParallelStateAst);
		return;
	}

	if (input.kind === "map") {
		if (role === "region") {
			diagnostics.push(diagnostic("INVALID_REGION", `Region '${path}' must be a compound state.`, pointer, source));
			return;
		}
		const initial = input.initial;
		if (typeof initial !== "string" || initial.length === 0) {
			diagnostics.push(
				diagnostic("INVALID_INITIAL", "Map initial must be a non-empty state id.", `${pointer}/initial`, source),
			);
		}
		if (!isRecord(input.states)) {
			diagnostics.push(diagnostic("INVALID_STATES", "Map states must be an object.", `${pointer}/states`, source));
			return;
		}
		const over = input.over === undefined ? undefined : toInputRef(input.over, `${pointer}/over`, diagnostics, source);
		if (input.over === undefined) {
			diagnostics.push(
				diagnostic("INVALID_MAP", `Map '${path}' must declare over — what it fans out on.`, `${pointer}/over`, source),
			);
		}
		let concurrency: number | undefined;
		if (input.concurrency !== undefined) {
			if (typeof input.concurrency !== "number" || !Number.isInteger(input.concurrency) || input.concurrency < 1) {
				diagnostics.push(
					diagnostic("INVALID_MAP", "Map concurrency must be a positive integer.", `${pointer}/concurrency`, source),
				);
			} else {
				concurrency = input.concurrency;
			}
		}
		const inputs = toInputDeclarations(input.input, `${pointer}/input`, diagnostics, source, schemaRegistry);
		const onReenter = toOnReenter(input.onReenter, `${pointer}/onReenter`, diagnostics, source, true);
		const transitions = toTransitionMap(input.transitions, `${pointer}/transitions`, diagnostics, source);
		const onDone = toOnDone(input.onDone, `${pointer}/onDone`, diagnostics, source);
		if (onDone === undefined) {
			diagnostics.push(diagnostic("MISSING_ON_DONE", `Map '${path}' must declare onDone.`, pointer, source));
		}
		for (const [childId, childInput] of Object.entries(input.states)) {
			collectState(
				childInput,
				chartId,
				childId,
				path,
				`${pointer}/states/${escapePointer(childId)}`,
				states,
				diagnostics,
				source,
				schemaRegistry,
			);
		}
		// An instance completes by reaching a direct final child — same rule as a compound.
		const hasFinal = Object.keys(input.states).some((childId) => states[`${path}.${childId}`]?.kind === "final");
		if (!hasFinal) {
			diagnostics.push(
				diagnostic("MISSING_FINAL", `State '${path}' must contain a final child (its completion).`, pointer, source),
			);
		}
		states[path] = deepFreeze({
			kind: "map",
			id: localId,
			...parent,
			...(inputs === undefined ? {} : { input: inputs }),
			over: over ?? { kind: "arg", name: "" },
			...(concurrency === undefined ? {} : { concurrency }),
			...(onReenter === undefined ? {} : { onReenter }),
			initial: typeof initial === "string" ? initial : "",
			transitions: transitions ?? {},
			onDone: onDone ?? "",
		} satisfies MapStateAst);
		return;
	}

	if (input.kind === "compound" || "states" in input) {
		const initial = input.initial;
		if (typeof initial !== "string" || initial.length === 0) {
			diagnostics.push(
				diagnostic("INVALID_INITIAL", "Compound initial must be a non-empty state id.", `${pointer}/initial`, source),
			);
		}
		if (!isRecord(input.states)) {
			diagnostics.push(diagnostic("INVALID_STATES", "Compound states must be an object.", `${pointer}/states`, source));
			return;
		}
		const transitions = toTransitionMap(input.transitions, `${pointer}/transitions`, diagnostics, source);
		const onDone = toOnDone(input.onDone, `${pointer}/onDone`, diagnostics, source);
		for (const [childId, childInput] of Object.entries(input.states)) {
			collectState(
				childInput,
				chartId,
				childId,
				path,
				`${pointer}/states/${escapePointer(childId)}`,
				states,
				diagnostics,
				source,
				schemaRegistry,
			);
		}
		// Every compound (and region) must be completable: a direct final child is its exit.
		const hasFinal = Object.keys(input.states).some((childId) => states[`${path}.${childId}`]?.kind === "final");
		if (!hasFinal) {
			diagnostics.push(
				diagnostic("MISSING_FINAL", `State '${path}' must contain a final child (its completion).`, pointer, source),
			);
		}
		if (role === "region") {
			if (input.onDone !== undefined) {
				diagnostics.push(
					diagnostic(
						"REGION_ON_DONE",
						`Region '${path}' must not declare onDone: a final child marks the region complete.`,
						`${pointer}/onDone`,
						source,
					),
				);
			}
			states[path] = deepFreeze({
				kind: "region",
				id: localId,
				...parent,
				initial: typeof initial === "string" ? initial : "",
				transitions: transitions ?? {},
			} satisfies RegionStateAst);
			return;
		}
		if (onDone === undefined) {
			diagnostics.push(diagnostic("MISSING_ON_DONE", `Compound '${path}' must declare onDone.`, pointer, source));
		}
		states[path] = deepFreeze({
			kind: "compound",
			id: localId,
			...parent,
			initial: typeof initial === "string" ? initial : "",
			transitions: transitions ?? {},
			onDone: onDone ?? "",
		} satisfies CompoundStateAst);
		return;
	}

	if ("action" in input) {
		if (role === "region") {
			diagnostics.push(diagnostic("INVALID_REGION", `Region '${path}' must be a compound state.`, pointer, source));
			return;
		}
		const action = toStateActionAst(
			input.action,
			chartId,
			path,
			`${pointer}/action`,
			diagnostics,
			source,
			schemaRegistry,
		);
		const inputs = toInputDeclarations(input.input, `${pointer}/input`, diagnostics, source, schemaRegistry);
		const transitions = toTransitionMap(input.transitions, `${pointer}/transitions`, diagnostics, source);
		const after = toAfter(input.after, `${pointer}/after`, diagnostics, source);
		const validate = toGuardRef(input.validate, `${pointer}/validate`, diagnostics, source, schemaRegistry);
		let onReject: OnReject | undefined;
		if (input.onReject !== undefined) {
			if (input.onReject !== "resume" && input.onReject !== "restart") {
				diagnostics.push(
					diagnostic("INVALID_ON_REJECT", "onReject must be 'resume' or 'restart'.", `${pointer}/onReject`, source),
				);
			} else if (input.validate === undefined) {
				diagnostics.push(diagnostic("INVALID_ON_REJECT", "onReject requires validate.", `${pointer}/onReject`, source));
			} else {
				onReject = input.onReject;
			}
		}
		const onReenter = toOnReenter(
			input.onReenter,
			`${pointer}/onReenter`,
			diagnostics,
			source,
			action?.kind === "agent",
		);
		let retries: number | undefined;
		if (input.retries !== undefined) {
			if (typeof input.retries !== "number" || !Number.isInteger(input.retries) || input.retries < 0) {
				diagnostics.push(
					diagnostic("INVALID_RETRIES", "retries must be a non-negative integer.", `${pointer}/retries`, source),
				);
			} else if (input.validate === undefined) {
				diagnostics.push(diagnostic("INVALID_RETRIES", "retries requires validate.", `${pointer}/retries`, source));
			} else {
				retries = input.retries;
			}
		}
		if (action === undefined) return;
		if (validate?.kind === "script") {
			const actionArtifacts = action.kind === "user" ? {} : action.artifacts ?? {};
			for (const name of Object.keys(validate.artifacts ?? {})) {
				if (Object.prototype.hasOwnProperty.call(actionArtifacts, name)) {
					diagnostics.push(
						diagnostic(
							"DUPLICATE_GUARD_ARTIFACT",
							`Validation script artifact '${name}' duplicates an artifact declared by action state '${path}'.`,
							`${pointer}/validate/artifacts/${escapePointer(name)}`,
							source,
						),
					);
				}
			}
		}
		states[path] = deepFreeze({
			kind: "state",
			id: localId,
			...parent,
			action,
			...(inputs === undefined ? {} : { input: inputs }),
			transitions: transitions ?? {},
			...(after === undefined ? {} : { after }),
			...(validate === undefined ? {} : { validate, onReject: onReject ?? "resume" }),
			...(onReenter === undefined ? {} : { onReenter }),
			...(retries === undefined ? {} : { retries }),
		} satisfies ActionStateAst);
		return;
	}

	diagnostics.push(diagnostic("MISSING_ACTION", "Non-final state must define exactly one action.", pointer, source));
}

// Shared by authoring validation and runtime rendering (machine.ts renderRead): both must agree
// on which artifacts a state exposes, or a reference accepted here would miss at render time.
export function declaredArtifactsForState(
	state: Extract<StateAst, { kind: "state" }>,
): Readonly<Record<string, ArtifactAst>> | undefined {
	if (state.action.kind === "user" && state.validate?.kind !== "script") return undefined;
	const merged: Record<string, ArtifactAst> = {};
	const add = (artifacts: Readonly<Record<string, ArtifactAst>> | undefined) => {
		for (const [name, artifact] of Object.entries(artifacts ?? {})) {
			Object.defineProperty(merged, name, { configurable: true, enumerable: true, value: artifact, writable: true });
		}
	};
	if (state.action.kind !== "user") add(state.action.artifacts);
	if (state.validate?.kind === "script") add((state.validate as GuardRefAst & { artifacts?: Readonly<Record<string, ArtifactAst>> }).artifacts);
	return Object.keys(merged).length === 0 ? undefined : merged;
}

function validateTerminalArtifactRef(
	states: Record<StatePath, StateAst>,
	terminalPath: StatePath,
	read: ArtifactOfAst | JoinArtifactOfAst,
	pointer: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	if (read.kind === "joinArtifactOf" && !insideMap(states, read.state)) {
		diagnostics.push(diagnostic("INVALID_MAP_REF", `joinArtifactOf in terminal '${terminalPath}' references '${read.state}', which is not inside a map.`, pointer, source));
	}
	const producer = states[read.state];
	const artifacts = producer?.kind === "state" ? declaredArtifactsForState(producer) : undefined;
	if (artifacts === undefined || Object.keys(artifacts).length === 0) {
		diagnostics.push(diagnostic("UNKNOWN_FILE_SOURCE", `artifactOf in terminal '${terminalPath}' references '${read.state}', which declares no artifacts.`, pointer, source));
		return;
	}
	if (read.artifact !== undefined && !Object.prototype.hasOwnProperty.call(artifacts, read.artifact)) {
		diagnostics.push(diagnostic("UNKNOWN_ARTIFACT", `artifactOf in terminal '${terminalPath}': '${read.state}' declares no artifact '${read.artifact}'.`, pointer, source));
	}
	if (read.artifact === undefined && Object.keys(artifacts).length > 1) {
		diagnostics.push(diagnostic("AMBIGUOUS_ARTIFACT", `artifactOf in terminal '${terminalPath}': '${read.state}' declares several artifacts — name one.`, pointer, source));
	}
}

// Every target — transition, after, onDone, container initial — resolves among the siblings of
// the level where it is declared; there is no path syntax in authoring. Completeness rules
// (final child, onDone presence) live in collectState; here only the targets are checked.
function validateTargets(
	states: Record<StatePath, StateAst>,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	for (const [path, node] of Object.entries(states)) {
		const pointer = statePointer(path);
		if (node.kind === "final") {
			const notify = node.notify;
			if (notify !== undefined) {
				const scope = notify.scope ?? path;
				if (!(scope in states)) {
					diagnostics.push(diagnostic("UNKNOWN_NOTIFICATION_SCOPE", `Terminal notification in '${path}' has unknown scope '${scope}'.`, `${pointer}/notify/scope`, source));
				} else if (notify.prompt !== undefined) {
					validateTemplateRefs(states, scope, notify.prompt, `${pointer}/notify/prompt`, diagnostics, source);
				}
				for (const [index, read] of (notify.artifacts ?? []).entries()) {
					validateTerminalArtifactRef(states, path, read, `${pointer}/notify/artifacts/${index}`, diagnostics, source);
				}
			}
			continue;
		}
		const sibling = (target: string) => (node.parent === undefined ? target : `${node.parent}.${target}`);
		for (const [eventType, transition] of Object.entries(node.transitions)) {
			const target = transition.target;
			if (!(sibling(target) in states)) {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_TRANSITION_TARGET",
						`Transition '${eventType}' in state '${path}' targets unknown state '${target}'.`,
						`${pointer}/transitions/${escapePointer(eventType)}`,
						source,
					),
				);
			} else if (node.kind === "region" && target !== node.id) {
				// Region siblings run concurrently: a region's own transitions may only restart it.
				diagnostics.push(
					diagnostic(
						"INVALID_REGION_TARGET",
						`Transition '${eventType}' on region '${path}' may only target the region itself.`,
						`${pointer}/transitions/${escapePointer(eventType)}`,
						source,
					),
				);
			}
		}
		if (node.kind === "state") {
			// An exhausted retry budget turns into a FAILED transition — it needs a route.
			if (node.retries !== undefined) {
				let handled = false;
				let cur: StateAst | undefined = node;
				while (cur !== undefined) {
					if (cur.kind !== "final" && "FAILED" in cur.transitions) {
						handled = true;
						break;
					}
					cur = cur.parent === undefined ? undefined : states[cur.parent];
				}
				if (!handled) {
					diagnostics.push(
						diagnostic(
							"MISSING_FAILED_ROUTE",
							`State '${path}' declares retries but no FAILED transition is reachable for the exhausted budget.`,
							`${pointer}/retries`,
							source,
						),
					);
				}
			}
			if (node.after !== undefined && !(sibling(node.after.target) in states)) {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_AFTER_TARGET",
						`after in state '${path}' targets unknown state '${node.after.target}'.`,
						`${pointer}/after/target`,
						source,
					),
				);
			}
			// An artifactOf reference must resolve to exactly one declared artifact.
			if (node.action.kind !== "user" || node.validate?.kind === "script") {
				const actionArtifactRefs = [
					...(node.action.kind === "agent" ? (node.action.reads ?? []) : []),
					...(node.action.kind === "script" ? Object.values(node.action.env ?? {}) : []),
				];
				const guardArtifactRefs = node.validate?.kind === "script" ? Object.values(node.validate.env ?? {}) : [];
				const artifactRefs = [...actionArtifactRefs, ...guardArtifactRefs].filter(
					(item): item is ArtifactOfAst | JoinArtifactOfAst =>
						typeof item !== "string" && (item.kind === "artifactOf" || item.kind === "joinArtifactOf"),
				);
				for (const read of artifactRefs) {
					if (read.kind === "joinArtifactOf" && !insideMap(states, read.state)) {
						diagnostics.push(
							diagnostic(
								"INVALID_MAP_REF",
								`joinArtifactOf in state '${path}' references '${read.state}', which is not inside a map.`,
								`${pointer}/action/reads`,
								source,
							),
						);
					}
					const producer = states[read.state];
					const selfGuardRef = node.validate?.kind === "script" && read.kind === "artifactOf" && read.state === path;
					const artifacts = producer?.kind === "state"
						? selfGuardRef && producer.action.kind !== "user"
							? producer.action.artifacts
							: declaredArtifactsForState(producer)
						: undefined;
					if (artifacts === undefined || Object.keys(artifacts).length === 0) {
						diagnostics.push(
							diagnostic(
								"UNKNOWN_FILE_SOURCE",
								`artifactOf in state '${path}' references '${read.state}', which declares no artifacts.`,
								`${pointer}/action/reads`,
								source,
							),
						);
						continue;
					}
					if (read.artifact !== undefined && !Object.prototype.hasOwnProperty.call(artifacts, read.artifact)) {
						diagnostics.push(
							diagnostic(
								"UNKNOWN_ARTIFACT",
								`artifactOf in state '${path}': '${read.state}' declares no artifact '${read.artifact}'.`,
								`${pointer}/action/reads`,
								source,
							),
						);
					}
					if (read.artifact === undefined && Object.keys(artifacts).length > 1) {
						diagnostics.push(
							diagnostic(
								"AMBIGUOUS_ARTIFACT",
								`artifactOf in state '${path}': '${read.state}' declares several artifacts — name one.`,
								`${pointer}/action/reads`,
								source,
							),
						);
					}
				}
			}
			// Result refs address action states by absolute path — data lookup, not control flow.
			for (const template of actionTemplates(node.action)) {
				validateTemplateRefs(states, path, template, `${pointer}/action`, diagnostics, source);
			}
			if (node.validate?.kind === "script") {
				for (const value of Object.values(node.validate.env ?? {})) {
					if (typeof value !== "string" && value.kind === "template") validateTemplateRefs(states, path, value, `${pointer}/validate/env`, diagnostics, source);
				}
				for (const declared of Object.values(node.validate.artifacts ?? {})) {
					validateTemplateRefs(states, path, declared.path, `${pointer}/validate/artifacts`, diagnostics, source);
				}
			}
			if (typeof node.onReenter === "object") {
				validateTemplateRefs(states, path, node.onReenter.message, `${pointer}/onReenter/message`, diagnostics, source);
			}
			continue;
		}
		if (node.kind === "map") {
			if (node.over.kind === "result" && states[node.over.state]?.kind !== "state") {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_INPUT_RESULT",
						`Map '${path}' fans out over the result of unknown action state '${node.over.state}'.`,
						`${pointer}/over`,
						source,
					),
				);
			}
			if (node.over.kind === "input" && !hasInputDeclaration(states, path, node.over.name)) {
				diagnostics.push(
					diagnostic(
						"UNKNOWN_INPUT",
						`Map '${path}' fans out over undeclared input '${node.over.name}'.`,
						`${pointer}/over`,
						source,
					),
				);
			}
			if (node.over.kind === "visit") {
				validateVisitRef(states, path, node.over.state, `${pointer}/over`, diagnostics, source);
			}
			if (typeof node.onReenter === "object") {
				validateTemplateRefs(
					states,
					path,
					node.onReenter.message,
					`${pointer}/onReenter/message`,
					diagnostics,
					source,
					{
						includeSelfMap: true,
					},
				);
			}
		}
		if (
			(node.kind === "compound" || node.kind === "region" || node.kind === "map") &&
			node.initial.length > 0 &&
			!(`${path}.${node.initial}` in states)
		) {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_INITIAL_STATE",
					`Initial state '${node.initial}' does not exist in '${path}'.`,
					`${pointer}/initial`,
					source,
				),
			);
		}
		if (
			(node.kind === "compound" || node.kind === "parallel" || node.kind === "map") &&
			node.onDone.length > 0 &&
			!(sibling(node.onDone) in states)
		) {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_ON_DONE_TARGET",
					`onDone in state '${path}' targets unknown state '${node.onDone}'.`,
					`${pointer}/onDone`,
					source,
				),
			);
		}
	}
}

// Entering a state must settle on leaves. The projection resolves an entry recursively
// (enterState): compounds and regions drill into their initial, parallels enter every region,
// and a final child immediately completes its compound through onDone — so initial/onDone hops
// form a resolution chain, and a cycle in it (A.onDone -> B, B drills to a final, B.onDone -> A)
// makes the projection recurse without bound. Maps break the chain (their placeholder rests
// until spawn), finals in regions/maps rest for the join.
function validateEnterCycles(
	states: Record<StatePath, StateAst>,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	const successors = (path: StatePath): StatePath[] => {
		const node = states[path];
		if (node === undefined) return [];
		if (node.kind === "compound" || node.kind === "region") return [`${path}.${node.initial}`];
		if (node.kind === "parallel") return node.regions.map((region) => `${path}.${region}`);
		if (node.kind === "final" && node.parent !== undefined) {
			const container = states[node.parent];
			if (container?.kind === "compound") {
				return [container.parent === undefined ? container.onDone : `${container.parent}.${container.onDone}`];
			}
		}
		return [];
	};
	const settled = new Set<StatePath>();
	const entering = new Set<StatePath>();
	const visit = (path: StatePath, trail: StatePath[]): void => {
		if (settled.has(path)) return;
		if (entering.has(path)) {
			const cycle = [...trail.slice(trail.indexOf(path)), path];
			diagnostics.push(
				diagnostic(
					"ON_DONE_CYCLE",
					`Entering '${path}' never settles: the initial/onDone chain loops (${cycle.join(" -> ")}).`,
					statePointer(path),
					source,
				),
			);
			return;
		}
		entering.add(path);
		for (const next of successors(path)) visit(next, [...trail, path]);
		entering.delete(path);
		settled.add(path);
	};
	for (const path of Object.keys(states)) visit(path, []);
}

function validateInputs(
	states: Record<StatePath, StateAst>,
	initial: StateId,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	const edges: Array<{
		target: StatePath;
		bindings?: Readonly<Record<string, EventBindingAst>>;
		pointer: string;
	}> = [];
	if (initial.length > 0 && initial in states) {
		edges.push({ target: initial, pointer: "/initial" });
	}
	for (const [path, node] of Object.entries(states)) {
		if (node.kind === "final") continue;
		const pointer = statePointer(path);
		const sibling = (target: string) => (node.parent === undefined ? target : `${node.parent}.${target}`);
		for (const [eventType, transition] of Object.entries(node.transitions)) {
			const target = sibling(transition.target);
			if (!(target in states)) continue;
			const inputTargets = inputEntryTargets(states, target);
			const declared = new Set(inputTargets.flatMap((entry) => Object.keys(entry.input)));
			for (const bindingName of Object.keys(transition.input ?? {})) {
				if (!declared.has(bindingName)) {
					diagnostics.push(
						diagnostic(
							"UNKNOWN_INPUT",
							`Transition '${eventType}' in state '${path}' binds undeclared input '${bindingName}' on target '${transition.target}'.`,
							`${pointer}/transitions/${escapePointer(eventType)}/input/${escapePointer(bindingName)}`,
							source,
						),
					);
				}
			}
			edges.push({
				target,
				pointer: `${pointer}/transitions/${escapePointer(eventType)}`,
				...(transition.input === undefined ? {} : { bindings: transition.input }),
			});
		}
		if (node.kind === "state" && node.after !== undefined) {
			const target = sibling(node.after.target);
			if (target in states) edges.push({ target, pointer: `${pointer}/after` });
		}
		if (node.kind === "map" && node.initial.length > 0) {
			const target = `${path}.${node.initial}`;
			if (target in states)
				edges.push({
					target,
					pointer: `${pointer}/states/${escapePointer(node.initial)}`,
				});
		}
		if ((node.kind === "compound" || node.kind === "parallel" || node.kind === "map") && node.onDone.length > 0) {
			const target = sibling(node.onDone);
			if (target in states) edges.push({ target, pointer: `${pointer}/onDone` });
		}
	}
	const edgesByInputTarget = new Map<StatePath, typeof edges>();
	for (const edge of edges) {
		for (const target of inputEntryTargets(states, edge.target)) {
			const list = edgesByInputTarget.get(target.path) ?? [];
			list.push(edge);
			edgesByInputTarget.set(target.path, list);
		}
	}
	for (const [path, node] of Object.entries(states)) {
		if ((node.kind !== "state" && node.kind !== "map") || node.input === undefined) continue;
		const incoming = edgesByInputTarget.get(path) ?? [];
		for (const [name, schema] of Object.entries(node.input)) {
			if (schemaHasDefault(schema)) continue;
			for (const edge of incoming) {
				if (edge.bindings?.[name] === undefined) {
					diagnostics.push(
						diagnostic(
							"MISSING_INPUT",
							`Input '${name}' for state '${path}' is required but the incoming edge at ${edge.pointer} does not bind it.`,
							statePointer(path),
							source,
						),
					);
					break;
				}
			}
		}
	}
}

function inputEntryTargets(
	states: Record<StatePath, StateAst>,
	path: StatePath,
): Array<{ path: StatePath; input: Readonly<Record<string, SchemaAst>> }> {
	const node = states[path];
	if (node === undefined) return [];
	if (node.kind === "state") {
		return node.input === undefined ? [] : [{ path, input: node.input }];
	}
	if (node.kind === "map") {
		return node.input === undefined ? [] : [{ path, input: node.input }];
	}
	if (node.kind === "compound" || node.kind === "region") {
		return inputEntryTargets(states, `${path}.${node.initial}`);
	}
	if (node.kind === "parallel") {
		return node.regions.flatMap((region) => inputEntryTargets(states, `${path}.${region}`));
	}
	if (node.kind === "final" && node.parent !== undefined) {
		const container = states[node.parent];
		if (container?.kind === "compound") {
			const target = container.parent === undefined ? container.onDone : `${container.parent}.${container.onDone}`;
			return inputEntryTargets(states, target);
		}
	}
	return [];
}

const DOMINATOR_START = "<start>";
type DominatorNode = StatePath | typeof DOMINATOR_START;

function validateDominatedRefs(
	states: Record<StatePath, StateAst>,
	initial: StateId,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	const graph = buildDominanceGraph(states, initial);
	const dominators = computeDominators(graph);
	const check = (producer: StatePath, consumer: StatePath, pointer: string, label: string, allowSelf = false) => {
		if (states[producer]?.kind !== "state") return;
		if ((allowSelf && producer === consumer) || dominatesForDataRef(states, dominators, producer, consumer)) return;
		diagnostics.push(
			diagnostic(
				"NON_DOMINATED_REF",
				`${label} in state '${consumer}' reads '${producer}', but '${producer}' does not dominate '${consumer}'. Pass feedback through input() for back-edges or restructure the chart.`,
				pointer,
				source,
			),
		);
	};

	for (const [path, node] of Object.entries(states)) {
		const pointer = statePointer(path);
		if (node.kind === "final") {
			for (const ref of node.notify?.prompt?.refs ?? []) {
				if (ref.kind === "result") check(ref.state, path, `${pointer}/notify/prompt`, "result()");
			}
			for (const [index, read] of (node.notify?.artifacts ?? []).entries()) {
				check(read.state, path, `${pointer}/notify/artifacts/${index}`, "artifactOf()");
			}
			continue;
		}
		if (node.kind === "state") {
			for (const template of actionTemplates(node.action)) {
				for (const ref of template.refs) {
					if (ref.kind === "result") check(ref.state, path, `${pointer}/action`, "result()");
				}
			}
			if (typeof node.onReenter === "object") {
				for (const ref of node.onReenter.message.refs) {
					if (ref.kind === "result") check(ref.state, path, `${pointer}/onReenter/message`, "result()");
				}
			}
			const reads = artifactReads(node.action, pointer);
			if (node.validate?.kind === "script") {
				for (const [name, value] of Object.entries(node.validate.env ?? {})) {
					if (typeof value !== "string" && (value.kind === "artifactOf" || value.kind === "joinArtifactOf")) {
						reads.push({ state: value.state, pointer: `${pointer}/validate/env/${escapePointer(name)}`, allowSelf: value.kind === "artifactOf" && value.state === path });
					}
					if (typeof value !== "string" && value.kind === "template") {
						for (const ref of value.refs) if (ref.kind === "result") check(ref.state, path, `${pointer}/validate/env/${escapePointer(name)}`, "result()");
					}
				}
				for (const [name, declared] of Object.entries(node.validate.artifacts ?? {})) {
					for (const ref of declared.path.refs) if (ref.kind === "result") check(ref.state, path, `${pointer}/validate/artifacts/${escapePointer(name)}`, "result()");
				}
			}
			for (const read of reads) {
				check(read.state, path, read.pointer, "artifactOf()", read.allowSelf);
			}
			continue;
		}
		if (node.kind === "map") {
			if (node.over.kind === "result") check(node.over.state, path, `${pointer}/over`, "result()");
			if (typeof node.onReenter === "object") {
				for (const ref of node.onReenter.message.refs) {
					if (ref.kind === "result") check(ref.state, path, `${pointer}/onReenter/message`, "result()");
				}
			}
		}
	}
}

function artifactReads(action: StateActionAst, basePointer: string): Array<{ state: StatePath; pointer: string; allowSelf?: boolean }> {
	const reads: Array<{ state: StatePath; pointer: string; allowSelf?: boolean }> = [];
	if (action.kind === "agent") {
		for (const [index, read] of (action.reads ?? []).entries()) {
			if (read.kind === "artifactOf" || read.kind === "joinArtifactOf") reads.push({ state: read.state, pointer: `${basePointer}/action/reads/${index}` });
		}
	}
	if (action.kind === "script") {
		for (const [name, value] of Object.entries(action.env ?? {})) {
			if (value.kind === "artifactOf" || value.kind === "joinArtifactOf") reads.push({ state: value.state, pointer: `${basePointer}/action/env/${escapePointer(name)}` });
		}
	}
	return reads;
}

function buildDominanceGraph(
	states: Record<StatePath, StateAst>,
	initial: StateId,
): Map<DominatorNode, Set<DominatorNode>> {
	const graph = new Map<DominatorNode, Set<DominatorNode>>([[DOMINATOR_START, new Set()]]);
	for (const path of Object.keys(states)) graph.set(path, new Set());
	const addEdge = (from: DominatorNode, to: StatePath) => {
		if (to in states) graph.get(from)?.add(to);
	};
	if (initial in states) addEdge(DOMINATOR_START, initial);

	for (const [path, node] of Object.entries(states)) {
		if (node.kind !== "final") {
			for (const transition of Object.values(node.transitions)) {
				addEdge(path, siblingTarget(node, transition.target));
			}
		}
		if (node.kind === "state" && node.after !== undefined) {
			addEdge(path, siblingTarget(node, node.after.target));
		}
		if (node.kind === "compound" || node.kind === "region") {
			addEdge(path, `${path}.${node.initial}`);
		}
		if (node.kind === "map") {
			addEdge(path, `${path}.${node.initial}`);
			// Empty fan-out completes immediately, so map-body states do not dominate onDone targets.
			addEdge(path, siblingTarget(node, node.onDone));
		}
		if (node.kind === "parallel") {
			for (const region of node.regions) addEdge(path, `${path}.${region}`);
			// Parallel onDone is an AND-join in the runtime; this edge keeps the join target reachable
			// for ordinary dominators, while parallelJoinDominates handles region products precisely.
			addEdge(path, siblingTarget(node, node.onDone));
		}
		if (node.kind === "final" && node.parent !== undefined) {
			const parent = states[node.parent];
			if (parent?.kind === "compound" || parent?.kind === "map") {
				addEdge(path, siblingTarget(parent, parent.onDone));
			}
		}
	}
	return graph;
}

function computeDominators(graph: Map<DominatorNode, Set<DominatorNode>>): Map<DominatorNode, Set<DominatorNode>> {
	const reachable = reachableNodes(graph);
	const predecessors = new Map<DominatorNode, Set<DominatorNode>>();
	for (const node of reachable) predecessors.set(node, new Set());
	for (const [from, targets] of graph) {
		if (!reachable.has(from)) continue;
		for (const to of targets) {
			if (reachable.has(to)) predecessors.get(to)?.add(from);
		}
	}
	const all = [...reachable];
	const dominators = new Map<DominatorNode, Set<DominatorNode>>();
	for (const node of all) {
		dominators.set(node, node === DOMINATOR_START ? new Set([DOMINATOR_START]) : new Set(all));
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of all) {
			if (node === DOMINATOR_START) continue;
			const preds = [...(predecessors.get(node) ?? [])];
			const next = new Set<DominatorNode>([node]);
			const intersection = intersectSets(preds.map((pred) => dominators.get(pred) ?? new Set<DominatorNode>()));
			for (const item of intersection) next.add(item);
			if (!sameSet(dominators.get(node) ?? new Set(), next)) {
				dominators.set(node, next);
				changed = true;
			}
		}
	}
	return dominators;
}

function reachableNodes(graph: Map<DominatorNode, Set<DominatorNode>>): Set<DominatorNode> {
	const reachable = new Set<DominatorNode>();
	const queue: DominatorNode[] = [DOMINATOR_START];
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index];
		if (node === undefined || reachable.has(node)) continue;
		reachable.add(node);
		for (const next of graph.get(node) ?? []) queue.push(next);
	}
	return reachable;
}

function dominatesForDataRef(
	states: Record<StatePath, StateAst>,
	dominators: Map<DominatorNode, Set<DominatorNode>>,
	producer: StatePath,
	consumer: StatePath,
): boolean {
	if (strictlyDominates(dominators, producer, consumer)) return true;
	return parallelJoinDominates(states, dominators, producer, consumer) || mapJoinDominates(states, dominators, producer, consumer);
}

function parallelJoinDominates(
	states: Record<StatePath, StateAst>,
	dominators: Map<DominatorNode, Set<DominatorNode>>,
	producer: StatePath,
	consumer: StatePath,
): boolean {
	const scope = enclosingParallelRegion(states, producer);
	if (scope === undefined || underStateScope(consumer, scope.parallelPath)) return false;
	const parallel = states[scope.parallelPath];
	if (parallel?.kind !== "parallel") return false;
	const joinTarget = siblingTarget(parallel, parallel.onDone);
	if (!isDominatedBy(dominators, scope.parallelPath, consumer)) return false;
	if (consumer !== joinTarget && !strictlyDominates(dominators, joinTarget, consumer)) return false;
	return finalDescendants(states, scope.regionPath).some((finalPath) =>
		strictlyDominates(dominators, producer, finalPath),
	);
}

function mapJoinDominates(
	states: Record<StatePath, StateAst>,
	dominators: Map<DominatorNode, Set<DominatorNode>>,
	producer: StatePath,
	consumer: StatePath,
): boolean {
	let mapPath = parentStatePath(producer);
	while (mapPath !== undefined && states[mapPath]?.kind !== "map") mapPath = parentStatePath(mapPath);
	if (mapPath === undefined || underStateScope(consumer, mapPath)) return false;
	const map = states[mapPath];
	if (map?.kind !== "map") return false;
	const joinTarget = siblingTarget(map, map.onDone);
	if (!isDominatedBy(dominators, mapPath, consumer)) return false;
	if (consumer !== joinTarget && !strictlyDominates(dominators, joinTarget, consumer)) return false;
	return finalDescendants(states, mapPath).some((finalPath) => strictlyDominates(dominators, producer, finalPath));
}

function enclosingParallelRegion(
	states: Record<StatePath, StateAst>,
	path: StatePath,
): { parallelPath: StatePath; regionPath: StatePath } | undefined {
	let cur = parentStatePath(path);
	while (cur !== undefined) {
		const node = states[cur];
		if (node?.kind === "region" && node.parent !== undefined && states[node.parent]?.kind === "parallel") {
			return { parallelPath: node.parent, regionPath: cur };
		}
		cur = parentStatePath(cur);
	}
	return undefined;
}

function finalDescendants(states: Record<StatePath, StateAst>, scope: StatePath): StatePath[] {
	return Object.entries(states).flatMap(([path, node]) =>
		node.kind === "final" && underStateScope(path, scope) ? [path] : [],
	);
}

function siblingTarget(node: StateAst, target: StateId): StatePath {
	return node.parent === undefined ? target : `${node.parent}.${target}`;
}

function parentStatePath(path: StatePath): StatePath | undefined {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? undefined : path.slice(0, dot);
}

function underStateScope(path: StatePath, scope: StatePath): boolean {
	return path === scope || path.startsWith(`${scope}.`);
}

function strictlyDominates(
	dominators: Map<DominatorNode, Set<DominatorNode>>,
	dominator: StatePath,
	node: StatePath,
): boolean {
	return dominator !== node && isDominatedBy(dominators, dominator, node);
}

function isDominatedBy(
	dominators: Map<DominatorNode, Set<DominatorNode>>,
	dominator: StatePath,
	node: StatePath,
): boolean {
	return dominators.get(node)?.has(dominator) === true;
}

function intersectSets<T>(sets: Set<T>[]): Set<T> {
	if (sets.length === 0) return new Set();
	const [first, ...rest] = sets;
	const result = new Set(first);
	for (const item of first ?? []) {
		if (!rest.every((set) => set.has(item))) result.delete(item);
	}
	return result;
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
	return left.size === right.size && [...left].every((item) => right.has(item));
}

function validateTemplateRefs(
	states: Record<StatePath, StateAst>,
	path: StatePath,
	template: TemplateAst,
	pointer: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	options: { includeSelfMap?: boolean } = {},
): void {
	for (const ref of template.refs) {
		if (
			(ref.kind === "key" || ref.kind === "item") &&
			!insideMap(states, path, ref.map, options.includeSelfMap === true)
		) {
			diagnostics.push(
				diagnostic(
					"INVALID_MAP_REF",
					ref.map === undefined
						? `A template in state '${path}' uses ${ref.kind}() outside any map.`
						: `A template in state '${path}' uses ${ref.kind}() outside map '${ref.map}'.`,
					pointer,
					source,
				),
			);
		}
		if (ref.kind === "result" && states[ref.state]?.kind !== "state") {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_INPUT_RESULT",
					`A template in state '${path}' reads the result of unknown action state '${ref.state}'.`,
					pointer,
					source,
				),
			);
		}
		if (ref.kind === "input" && !hasInputDeclaration(states, path, ref.name)) {
			diagnostics.push(
				diagnostic(
					"UNKNOWN_INPUT",
					`A template in state '${path}' reads undeclared input '${ref.name}'.`,
					pointer,
					source,
				),
			);
		}
		if (ref.kind === "visit") {
			validateVisitRef(states, path, ref.state, pointer, diagnostics, source);
		}
	}
}

function validateVisitRef(
	states: Record<StatePath, StateAst>,
	scope: StatePath,
	stateRef: StatePath | undefined,
	pointer: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): void {
	const target = stateRef ?? scope;
	if (states[target]?.kind !== "state") {
		diagnostics.push(
			diagnostic(
				"INVALID_VISIT_REF",
				stateRef === undefined
					? `visit() in state '${scope}' must resolve to an action state.`
					: `visit('${stateRef}') in state '${scope}' references a non-action state.`,
				pointer,
				source,
			),
		);
	}
}

function hasInputDeclaration(states: Record<StatePath, StateAst>, path: StatePath, name: string): boolean {
	let cur: StatePath | undefined = path;
	while (cur !== undefined) {
		const node: StateAst | undefined = states[cur];
		if ((node?.kind === "state" || node?.kind === "map") && node.input !== undefined && name in node.input) {
			return true;
		}
		cur = node?.parent;
	}
	return false;
}

function schemaHasDefault(schema: SchemaAst): boolean {
	return isRecord(schema.schema) && "default" in schema.schema;
}

// Is `path` inside a map — any map, or (when `map` names one) that specific ancestor.
function insideMap(
	states: Record<StatePath, StateAst>,
	path: StatePath,
	map?: StatePath,
	includeSelf = false,
): boolean {
	let cur = includeSelf ? path : states[path]?.parent;
	while (cur !== undefined) {
		if (states[cur]?.kind === "map" && (map === undefined || cur === map)) return true;
		cur = states[cur]?.parent;
	}
	return false;
}

// All templated parameters of an action, for ref validation.
function actionTemplates(action: StateActionAst): readonly TemplateAst[] {
	if (action.kind === "user") {
		return [action.prompt];
	}
	return [
		...(action.kind === "agent" && action.task ? [action.task] : []),
		...(action.kind === "script"
			? Object.values(action.env ?? {}).filter((value): value is TemplateAst => value.kind === "template")
			: []),
		...Object.values(action.artifacts ?? {}).map((declared) => declared.path),
		...(action.kind === "agent" ? (action.reads ?? []) : []).filter(
			(read): read is TemplateAst => read.kind === "template",
		),
	];
}

function toTerminalNotification(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): TerminalNotificationAst | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_TERMINAL_NOTIFICATION", "notify must be an object.", path, source));
		return undefined;
	}
	const prompt = toTemplate(input.prompt, `${path}/prompt`, diagnostics, source);
	let artifacts: (ArtifactOfAst | JoinArtifactOfAst)[] | undefined;
	if (input.artifacts !== undefined) {
		if (!Array.isArray(input.artifacts)) {
			diagnostics.push(diagnostic("INVALID_TERMINAL_NOTIFICATION", "notify.artifacts must be an array of artifactOf()/joinArtifactOf() references.", `${path}/artifacts`, source));
		} else {
			artifacts = [];
			for (const [index, item] of input.artifacts.entries()) {
				const pointer = `${path}/artifacts/${index}`;
				const ref = isRecord(item) && item.kind === "artifactOf"
					? toArtifactOf(item, pointer, diagnostics, source)
					: isRecord(item) && item.kind === "joinArtifactOf"
						? toJoinArtifactOf(item, pointer, diagnostics, source)
						: undefined;
				if (ref === undefined && !(isRecord(item) && (item.kind === "artifactOf" || item.kind === "joinArtifactOf"))) {
					diagnostics.push(diagnostic("INVALID_TERMINAL_NOTIFICATION", "notify artifacts must use artifactOf() or joinArtifactOf().", pointer, source));
				}
				if (ref !== undefined) artifacts.push(ref);
			}
		}
	}
	const scope = typeof input.scope === "string" && input.scope.length > 0 ? input.scope : undefined;
	if (input.scope !== undefined && scope === undefined) {
		diagnostics.push(diagnostic("INVALID_TERMINAL_NOTIFICATION", "notify.scope must be a non-empty state path.", `${path}/scope`, source));
	}
	return {
		...(prompt === undefined ? {} : { prompt }),
		...(artifacts === undefined ? {} : { artifacts }),
		...(scope === undefined ? {} : { scope }),
	};
}

function toTemplate(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): TemplateAst | undefined {
	if (input === undefined) return undefined;
	// A plain string is a template with no refs.
	if (typeof input === "string") {
		return { kind: "template", strings: [input], refs: [] };
	}
	if (!isRecord(input) || input.kind !== "template" || !Array.isArray(input.strings) || !Array.isArray(input.refs)) {
		diagnostics.push(diagnostic("INVALID_TEMPLATE", "Expected a string or a t`...` template.", path, source));
		return undefined;
	}
	const strings = input.strings;
	if (!strings.every((part): part is string => typeof part === "string") || strings.length !== input.refs.length + 1) {
		diagnostics.push(diagnostic("INVALID_TEMPLATE", "Malformed template parts.", path, source));
		return undefined;
	}
	const refs: InputRef[] = [];
	for (const [index, raw] of input.refs.entries()) {
		const ref = toInputRef(raw, `${path}/${index}`, diagnostics, source);
		if (ref === undefined) return undefined;
		refs.push(ref);
	}
	return { kind: "template", strings, refs };
}

function toArtifacts(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
): Record<string, ArtifactAst> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_ARTIFACT", "artifacts must be a map of name → artifact.", path, source));
		return undefined;
	}
	const artifacts: Record<string, ArtifactAst> = {};
	for (const [name, item] of Object.entries(input)) {
		const pointer = `${path}/${escapePointer(name)}`;
		if (isRecord(item) && item.kind === "artifact") {
			const template = toTemplate(item.path, `${pointer}/path`, diagnostics, source);
			if (template === undefined) {
				diagnostics.push(diagnostic("INVALID_ARTIFACT", `Artifact '${name}' requires a path.`, pointer, source));
				continue;
			}
			const shape = toSchemaAst(item.shape, `${pointer}/shape`, diagnostics, source, schemaRegistry);
			Object.defineProperty(artifacts, name, {
				configurable: true,
				enumerable: true,
				value: {
					path: template,
					...(shape === undefined ? {} : { shape }),
				},
				writable: true,
			});
			continue;
		}
		const template = toTemplate(item, pointer, diagnostics, source);
		if (template !== undefined) {
			Object.defineProperty(artifacts, name, {
				configurable: true,
				enumerable: true,
				value: { path: template },
				writable: true,
			});
		}
	}
	return artifacts;
}

function toEnv(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(
			diagnostic("INVALID_SCRIPT", "Script env must be a map of name → template or artifactOf.", path, source),
		);
		return undefined;
	}
	const env: Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst> = {};
	for (const [name, value] of Object.entries(input)) {
		const pointer = `${path}/${escapePointer(name)}`;
		if (isRecord(value) && value.kind === "artifactOf") {
			const ref = toArtifactOf(value, pointer, diagnostics, source);
			if (ref !== undefined) env[name] = ref;
			continue;
		}
		if (isRecord(value) && value.kind === "joinArtifactOf") {
			const ref = toJoinArtifactOf(value, pointer, diagnostics, source);
			if (ref !== undefined) env[name] = ref;
			continue;
		}
		const template = toTemplate(value, pointer, diagnostics, source);
		if (template !== undefined) env[name] = template;
	}
	return env;
}

function toArtifactOf(
	item: Record<string, unknown>,
	pointer: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): ArtifactOfAst | undefined {
	if (typeof item.state !== "string" || item.state.length === 0) {
		diagnostics.push(
			diagnostic("INVALID_TEMPLATE", "artifactOf state must be a non-empty state path.", pointer, source),
		);
		return undefined;
	}
	if (item.artifact !== undefined && (typeof item.artifact !== "string" || item.artifact.length === 0)) {
		diagnostics.push(diagnostic("INVALID_TEMPLATE", "artifactOf artifact must be a non-empty name.", pointer, source));
		return undefined;
	}
	if (item.select !== undefined && (typeof item.select !== "string" || item.select.length === 0)) {
		diagnostics.push(
			diagnostic("INVALID_TEMPLATE", "artifactOf select must be a non-empty dot-path.", pointer, source),
		);
		return undefined;
	}
	return {
		kind: "artifactOf",
		state: item.state,
		...(item.artifact === undefined ? {} : { artifact: item.artifact }),
		...(item.select === undefined ? {} : { select: item.select }),
	};
}

function toJoinArtifactOf(
	item: Record<string, unknown>,
	pointer: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): JoinArtifactOfAst | undefined {
	if (typeof item.state !== "string" || item.state.length === 0) {
		diagnostics.push(
			diagnostic("INVALID_TEMPLATE", "joinArtifactOf state must be a non-empty state path.", pointer, source),
		);
		return undefined;
	}
	if (item.artifact !== undefined && (typeof item.artifact !== "string" || item.artifact.length === 0)) {
		diagnostics.push(
			diagnostic("INVALID_TEMPLATE", "joinArtifactOf artifact must be a non-empty name.", pointer, source),
		);
		return undefined;
	}
	return {
		kind: "joinArtifactOf",
		state: item.state,
		...(item.artifact === undefined ? {} : { artifact: item.artifact }),
	};
}

function toReads(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[] | undefined {
	if (input === undefined) return undefined;
	if (!Array.isArray(input)) {
		diagnostics.push(
			diagnostic(
				"INVALID_TEMPLATE",
				"reads must be an array of artifactOf() refs, strings or templates.",
				path,
				source,
			),
		);
		return undefined;
	}
	const reads: (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[] = [];
	for (const [index, item] of input.entries()) {
		if (isRecord(item) && item.kind === "artifactOf") {
			const ref = toArtifactOf(item, `${path}/${index}`, diagnostics, source);
			if (ref !== undefined) reads.push(ref);
			continue;
		}
		if (isRecord(item) && item.kind === "joinArtifactOf") {
			const ref = toJoinArtifactOf(item, `${path}/${index}`, diagnostics, source);
			if (ref !== undefined) reads.push(ref);
			continue;
		}
		const template = toTemplate(item, `${path}/${index}`, diagnostics, source);
		if (template !== undefined) reads.push(template);
	}
	return reads;
}

function toInputRef(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): InputRef | undefined {
	if (!isRecord(input)) {
		diagnostics.push(
			diagnostic(
				"INVALID_TEMPLATE",
				"Template interpolations must be arg()/result()/input() refs, not inline values.",
				path,
				source,
			),
		);
		return undefined;
	}
	if (input.json !== undefined && input.json !== true) {
		diagnostics.push(diagnostic("INVALID_TEMPLATE", "ref json mark must be `true` when present.", path, source));
		return undefined;
	}
	const jsonMark = input.json === true ? { json: true as const } : {};
	if (input.kind === "arg") {
		if (typeof input.name !== "string" || input.name.length === 0) {
			diagnostics.push(diagnostic("INVALID_TEMPLATE", "arg ref name must be a non-empty string.", path, source));
			return undefined;
		}
		return { kind: "arg", name: input.name, ...jsonMark };
	}
	if (input.kind === "result") {
		if (typeof input.state !== "string" || input.state.length === 0) {
			diagnostics.push(
				diagnostic("INVALID_TEMPLATE", "result ref state must be a non-empty state path.", path, source),
			);
			return undefined;
		}
		if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) {
			diagnostics.push(
				diagnostic("INVALID_TEMPLATE", "result ref path selector must be a non-empty string.", path, source),
			);
			return undefined;
		}
		return {
			kind: "result",
			state: input.state,
			...(input.path === undefined ? {} : { path: input.path }),
			...jsonMark,
		};
	}
	if (input.kind === "visit") {
		if (input.state !== undefined && (typeof input.state !== "string" || input.state.length === 0)) {
			diagnostics.push(diagnostic("INVALID_TEMPLATE", "visit ref state must be a non-empty state path.", path, source));
			return undefined;
		}
		return {
			kind: "visit",
			...(input.state === undefined ? {} : { state: input.state }),
			...jsonMark,
		};
	}
	if (input.kind === "input") {
		if (typeof input.name !== "string" || input.name.length === 0) {
			diagnostics.push(diagnostic("INVALID_TEMPLATE", "input ref name must be a non-empty string.", path, source));
			return undefined;
		}
		if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) {
			diagnostics.push(
				diagnostic("INVALID_TEMPLATE", "input ref path selector must be a non-empty string.", path, source),
			);
			return undefined;
		}
		return {
			kind: "input",
			name: input.name,
			...(input.path === undefined ? {} : { path: input.path }),
			...jsonMark,
		};
	}
	if (input.kind === "key" || input.kind === "item") {
		if (input.map !== undefined && (typeof input.map !== "string" || input.map.length === 0)) {
			diagnostics.push(
				diagnostic("INVALID_TEMPLATE", `${input.kind} ref map must be a non-empty state path.`, path, source),
			);
			return undefined;
		}
		const mapField = input.map === undefined ? {} : { map: input.map };
		if (input.kind === "key") {
			return { kind: "key", ...mapField, ...jsonMark };
		}
		if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) {
			diagnostics.push(
				diagnostic("INVALID_TEMPLATE", "item ref path selector must be a non-empty string.", path, source),
			);
			return undefined;
		}
		return {
			kind: "item",
			...mapField,
			...(input.path === undefined ? {} : { path: input.path }),
			...jsonMark,
		};
	}
	diagnostics.push(
		diagnostic(
			"INVALID_TEMPLATE",
			"Template ref kind must be 'arg', 'result', 'input', 'visit', 'key' or 'item'.",
			path,
			source,
		),
	);
	return undefined;
}

// Frontmatter overrides of the subagent definition; opaque to the engine, shape-checked only.
function toAgentOverrides(
	input: Record<string, unknown>,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): { model?: string; thinking?: string; tools?: readonly string[] } {
	const overrides: {
		model?: string;
		thinking?: string;
		tools?: readonly string[];
	} = {};
	for (const key of ["model", "thinking"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length === 0) {
			diagnostics.push(
				diagnostic("INVALID_AGENT_OPTION", `Agent ${key} must be a non-empty string.`, `${path}/${key}`, source),
			);
			continue;
		}
		overrides[key] = value;
	}
	if (input.tools !== undefined) {
		if (Array.isArray(input.tools) && input.tools.every((tool): tool is string => typeof tool === "string")) {
			overrides.tools = input.tools;
		} else {
			diagnostics.push(
				diagnostic("INVALID_AGENT_OPTION", "Agent tools must be an array of strings.", `${path}/tools`, source),
			);
		}
	}
	return overrides;
}

function toOnDone(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): string | undefined {
	if (input === undefined) return undefined;
	if (typeof input !== "string" || input.length === 0) {
		diagnostics.push(diagnostic("INVALID_ON_DONE", "onDone must be a non-empty state id.", path, source));
		return undefined;
	}
	return input;
}

function toOnReenter(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	allowResume: boolean,
): OnReenterAst | undefined {
	if (input === undefined) return undefined;
	if (input === "restart") return "restart";
	if (!isRecord(input) || input.kind !== "resume") {
		diagnostics.push(
			diagnostic("INVALID_ON_REENTER", "onReenter must be 'restart' or { kind: 'resume', message }.", path, source),
		);
		return undefined;
	}
	if (!allowResume) {
		diagnostics.push(diagnostic("INVALID_ON_REENTER", "onReenter resume requires an agent action.", path, source));
		return undefined;
	}
	const message = toTemplate(input.message, `${path}/message`, diagnostics, source);
	if (message === undefined) {
		diagnostics.push(diagnostic("INVALID_ON_REENTER", "onReenter resume requires a message.", path, source));
		return undefined;
	}
	return { kind: "resume", message };
}

function statePointer(path: StatePath): string {
	return `/states/${path.split(".").map(escapePointer).join("/states/")}`;
}

function toScriptOptions(
	input: Record<string, unknown>,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
	code: "INVALID_SCRIPT" | "INVALID_GUARD",
): {
	args?: readonly string[];
	env?: Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst>;
	artifacts?: Record<string, ArtifactAst>;
	reply?: SchemaAst;
} {
	const args = Array.isArray(input.args) ? input.args : [];
	if (input.args !== undefined && !Array.isArray(input.args)) {
		diagnostics.push(diagnostic(code, "Script args must be an array of strings.", `${path}/args`, source));
	}
	if (!args.every((item): item is string => typeof item === "string")) {
		diagnostics.push(diagnostic(code, "Script args must be strings.", `${path}/args`, source));
	}
	const env = toEnv(input.env, `${path}/env`, diagnostics, source);
	const artifacts = toArtifacts(input.artifacts, `${path}/artifacts`, diagnostics, source, schemaRegistry);
	const reply = toSchemaAst(input.reply, `${path}/reply`, diagnostics, source, schemaRegistry);
	const filteredArgs = args.filter((item): item is string => typeof item === "string");
	return {
		...(filteredArgs.length === 0 ? {} : { args: filteredArgs }),
		...(env === undefined ? {} : { env }),
		...(artifacts === undefined ? {} : { artifacts }),
		...(reply === undefined ? {} : { reply }),
	};
}

function toStateActionAst(
	input: unknown,
	chartId: string,
	statePath: StatePath,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
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
			const task = toTemplate(input.task, `${path}/task`, diagnostics, source);
			const artifacts = toArtifacts(input.artifacts, `${path}/artifacts`, diagnostics, source, schemaRegistry);
			const reads = toReads(input.reads, `${path}/reads`, diagnostics, source);
			const overrides = toAgentOverrides(input, path, diagnostics, source);
			const reply = toSchemaAst(input.reply, `${path}/reply`, diagnostics, source, schemaRegistry);
			const uid: ActionUID = {
				chart: chartId,
				state: statePath,
				action: "agent",
			};
			return deepFreeze({
				kind: "agent",
				uid,
				name: typeof input.name === "string" ? input.name : "",
				...(task === undefined ? {} : { task }),
				...(artifacts === undefined ? {} : { artifacts }),
				...(reads === undefined ? {} : { reads }),
				...overrides,
				...(reply === undefined ? {} : { reply }),
			} satisfies AgentActionAst);
		}
		case "script": {
			if (typeof input.command !== "string" || input.command.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_SCRIPT", "Script command must be a non-empty string.", `${path}/command`, source),
				);
			}
			const options = toScriptOptions(input, path, diagnostics, source, schemaRegistry, "INVALID_SCRIPT");
			const uid: ActionUID = {
				chart: chartId,
				state: statePath,
				action: "script",
			};
			return deepFreeze({
				kind: "script",
				uid,
				command: typeof input.command === "string" ? input.command : "",
				args: options.args ?? [],
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
				...(options.reply === undefined ? {} : { reply: options.reply }),
			} satisfies ScriptActionAst);
		}
		case "user": {
			const prompt = toTemplate(input.prompt, `${path}/prompt`, diagnostics, source);
			if (prompt === undefined) {
				diagnostics.push(
					diagnostic("INVALID_USER_PROMPT", "User prompt must be a string or template.", `${path}/prompt`, source),
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
			const reply = toSchemaAst(input.reply, `${path}/reply`, diagnostics, source, schemaRegistry);
			const uid: ActionUID = {
				chart: chartId,
				state: statePath,
				action: "user",
			};
			return deepFreeze({
				kind: "user",
				uid,
				prompt: prompt ?? { kind: "template", strings: [""], refs: [] },
				options: options.filter((option): option is string => typeof option === "string"),
				...(reply === undefined ? {} : { reply }),
			} satisfies UserActionAst);
		}
		default:
			diagnostics.push(
				diagnostic("INVALID_ACTION_KIND", "Action kind must be 'agent', 'user' or 'script'.", `${path}/kind`, source),
			);
			return undefined;
	}
}

// Shapes are authored as zod values only; the AST stores their plain JSON Schema conversion.
function toSchemaAst(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
): SchemaAst | undefined {
	if (input === undefined) return undefined;
	if (input instanceof z.ZodType) {
		const runtimeContract = runtimeContractMetadata(input);
		if (runtimeContract !== undefined) {
			try {
				schemaRegistry.register(runtimeContract, input);
			} catch (error) {
				diagnostics.push(
					diagnostic(
						"CONFLICTING_SCHEMA_CONTRACT",
						error instanceof Error ? error.message : String(error),
						path,
						source,
					),
				);
				return undefined;
			}
		}
		try {
			const schema =
				runtimeContract === undefined
					? z.toJSONSchema(input)
					: z.toJSONSchema(input, { io: "input", unrepresentable: "any" });
			return {
				kind: "jsonSchema",
				schema,
				...(runtimeContract === undefined ? {} : { runtimeContract }),
			};
		} catch (error) {
			diagnostics.push(
				diagnostic("INVALID_SCHEMA", `zod schema is not representable as JSON Schema: ${String(error)}`, path, source),
			);
			return undefined;
		}
	}
	diagnostics.push(diagnostic("INVALID_SCHEMA", "A shape must be a zod schema value.", path, source));
	return undefined;
}

function toInputDeclarations(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
	schemaRegistry: SchemaRegistry,
): Record<string, SchemaAst> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_INPUT", "input must be a map of name → zod schema.", path, source));
		return undefined;
	}
	const inputs: Record<string, SchemaAst> = {};
	for (const [name, schema] of Object.entries(input)) {
		if (name.length === 0) {
			diagnostics.push(
				diagnostic("INVALID_INPUT", "input names must be non-empty.", `${path}/${escapePointer(name)}`, source),
			);
			continue;
		}
		if (runtimeContractMetadata(schema) !== undefined) {
			diagnostics.push(
				diagnostic(
					"INVALID_INPUT",
					"Exact runtime contracts are not supported for state or map inputs; use an ordinary Zod schema.",
					`${path}/${escapePointer(name)}`,
					source,
				),
			);
			continue;
		}
		const ast = toSchemaAst(schema, `${path}/${escapePointer(name)}`, diagnostics, source, schemaRegistry);
		if (ast !== undefined) inputs[name] = ast;
	}
	return inputs;
}

function toTransitionMap(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): Record<string, TransitionAst> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(diagnostic("INVALID_TRANSITIONS", "Transitions must be an object map.", path, source));
		return undefined;
	}
	const transitions: Record<string, TransitionAst> = {};
	for (const [eventType, raw] of Object.entries(input)) {
		const pointer = `${path}/${escapePointer(eventType)}`;
		if (typeof raw === "string") {
			if (raw.length === 0) {
				diagnostics.push(
					diagnostic("INVALID_TRANSITION_TARGET", "Transition target must be a non-empty state id.", pointer, source),
				);
				continue;
			}
			transitions[eventType] = { target: raw };
			continue;
		}
		if (!isRecord(raw)) {
			diagnostics.push(
				diagnostic(
					"INVALID_TRANSITION_TARGET",
					"Transition must be a non-empty state id or an object with target.",
					pointer,
					source,
				),
			);
			continue;
		}
		if (typeof raw.target !== "string" || raw.target.length === 0) {
			diagnostics.push(
				diagnostic(
					"INVALID_TRANSITION_TARGET",
					"Transition target must be a non-empty state id.",
					`${pointer}/target`,
					source,
				),
			);
			continue;
		}
		const bindings = toEventBindings(raw.input, `${pointer}/input`, diagnostics, source);
		if (eventType === "FAILED" && bindings !== undefined && Object.keys(bindings).length > 0) {
			diagnostics.push(
				diagnostic(
					"INVALID_BINDING",
					"FAILED transitions cannot bind input in this phase.",
					`${pointer}/input`,
					source,
				),
			);
		}
		transitions[eventType] = {
			target: raw.target,
			...(bindings === undefined ? {} : { input: bindings }),
		};
	}
	return transitions;
}

function toEventBindings(
	input: unknown,
	path: string,
	diagnostics: AuthoringDiagnostic[],
	source: ChartSource,
): Record<string, EventBindingAst> | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) {
		diagnostics.push(
			diagnostic("INVALID_BINDING", "Transition input must be a map of name → event() binding.", path, source),
		);
		return undefined;
	}
	const bindings: Record<string, EventBindingAst> = {};
	for (const [name, raw] of Object.entries(input)) {
		const pointer = `${path}/${escapePointer(name)}`;
		if (!isRecord(raw) || raw.kind !== "event") {
			diagnostics.push(
				diagnostic("INVALID_BINDING", "Transition input values must be event() bindings.", pointer, source),
			);
			continue;
		}
		if (raw.path !== undefined && (typeof raw.path !== "string" || raw.path.length === 0)) {
			diagnostics.push(diagnostic("INVALID_BINDING", "event() path must be a non-empty string.", pointer, source));
			continue;
		}
		bindings[name] = {
			kind: "event",
			...(raw.path === undefined ? {} : { path: raw.path }),
		};
	}
	return bindings;
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
	schemaRegistry: SchemaRegistry,
): GuardRefAst | undefined {
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
			const options = toScriptOptions(input, path, diagnostics, source, schemaRegistry, "INVALID_GUARD");
			return deepFreeze({ kind: "script", command: input.command, ...options } satisfies GuardRefAst);
		}
		default:
			diagnostics.push(
				diagnostic("INVALID_GUARD", "Guard kind must be 'tsImport' or 'script'.", `${path}/kind`, source),
			);
			return undefined;
	}
}

function diagnostic(code: string, message: string, path: string, source: ChartSource): AuthoringDiagnostic {
	return {
		code,
		message,
		...(path ? { path } : {}),
		...(Object.keys(source).length > 0 ? { source } : {}),
	};
}

function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
