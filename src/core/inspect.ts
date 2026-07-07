import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { normalizeChartConfig } from "./normalize.js";
import type {
	ArtifactAst,
	ArtifactOfAst,
	ChartAst,
	EventBindingAst,
	InputRef,
	JoinArtifactOfAst,
	JsonSchema,
	OnReenterAst,
	ParsedChart,
	SchemaAst,
	StateActionAst,
	StateAst,
	StatePath,
	TemplateAst,
} from "./types.js";

export type InspectChartModuleOptions = {
	exportName?: string;
};

export type HyperchartInspectArtifact = {
	name: string;
	path?: string;
	shape?: JsonSchema;
};

export type HyperchartInspectInput = {
	name: string;
	schema: JsonSchema;
	required: boolean;
	defaultValue?: unknown;
};

export type HyperchartInspectTransition = {
	event: string;
	target: string;
	input?: Record<string, string>;
};

export type HyperchartInspectRef = {
	kind: InputRef["kind"] | "artifactOf" | "joinArtifactOf";
	preview: string;
	state?: string;
	name?: string;
	path?: string;
	json?: boolean;
};

export type HyperchartInspectOnReenter =
	| { mode: "restart" }
	| { mode: "resume"; message?: string; refs?: HyperchartInspectRef[] };

export type HyperchartInspectState = {
	id: string;
	kind: "agent" | "user" | "script" | "map" | "parallel" | "compound" | "region" | "final";
	agent?: string;
	task?: string;
	command?: string;
	envKeys?: string[];
	reads?: string[];
	refs?: HyperchartInspectRef[];
	inputs?: HyperchartInspectInput[];
	onReenter?: HyperchartInspectOnReenter;
	artifacts?: HyperchartInspectArtifact[];
	reply?: JsonSchema;
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	over?: string;
	concurrency?: number;
	regions?: string[];
	retries?: number;
	transitions?: HyperchartInspectTransition[];
};

export type HyperchartInspectResult = {
	chartId: string;
	chartPath?: string;
	exportName?: string;
	states: HyperchartInspectState[];
};

export function parseChartModuleSync(filePath: string, options: InspectChartModuleOptions = {}): ParsedChart {
	const absolutePath = resolve(filePath);
	const jiti = createJiti(pathToFileURL(absolutePath).href, {
		interopDefault: true,
		alias: { "pi-hyperchart": selfEntryPath() },
	});
	try {
		const module = jiti(absolutePath) as Record<string, unknown>;
		const exportName = options.exportName ?? "default";
		return normalizeChartConfig(module[exportName], { path: absolutePath, exportName });
	} catch (cause) {
		return {
			ok: false,
			source: { path: absolutePath, exportName: options.exportName ?? "default" },
			diagnostics: [
				{
					code: "TS_MODULE_LOAD_FAILED",
					message: `Unable to load chart module: ${cause instanceof Error ? cause.message : String(cause)}`,
					source: { path: absolutePath, exportName: options.exportName ?? "default" },
				},
			],
		};
	}
}

function selfEntryPath(): string {
	const js = fileURLToPath(new URL("../index.js", import.meta.url));
	if (existsSync(js)) return js;
	return fileURLToPath(new URL("../index.ts", import.meta.url));
}

export function inspectChartModuleSync(filePath: string, options: InspectChartModuleOptions = {}): HyperchartInspectResult {
	const absolutePath = resolve(filePath);
	const parsed = parseChartModuleSync(absolutePath, options);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return inspectChartAst(parsed.ast, {
		chartPath: absolutePath,
		...(options.exportName === undefined ? {} : { exportName: options.exportName }),
	});
}

export function inspectChartAst(
	ast: ChartAst,
	options: { chartPath?: string; exportName?: string } = {},
): HyperchartInspectResult {
	return {
		chartId: ast.id,
		...(options.chartPath === undefined ? {} : { chartPath: options.chartPath }),
		...(options.exportName === undefined ? {} : { exportName: options.exportName }),
		states: statesFromAst(ast),
	};
}

function statesFromAst(ast: ChartAst): HyperchartInspectState[] {
	return Object.entries(ast.states).map(([path, state]) => {
		if (state.kind === "final") return { id: path, kind: "final" };
		const transitions = transitionEntries(state);
		return {
			...stateFromAst(path, state),
			...(transitions.length === 0 ? {} : { transitions }),
		};
	});
}

function stateFromAst(path: string, state: Exclude<StateAst, { kind: "final" }>): HyperchartInspectState {
	if (state.kind === "state") return actionStateFromAst(path, state);
	if (state.kind === "map") {
		const refs = [inputRefInfo(state.over)];
		const inputs = inputDefinitions(state.input);
		return {
			id: path,
			kind: "map",
			over: inputRefPreview(state.over),
			refs,
			...(inputs === undefined ? {} : { inputs }),
			...(state.onReenter === undefined ? {} : { onReenter: onReenterInfo(state.onReenter) }),
			...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		};
	}
	if (state.kind === "parallel") {
		return { id: path, kind: "parallel", regions: state.regions.map((region) => `${path}.${region}`) };
	}
	return { id: path, kind: state.kind };
}

function actionStateFromAst(path: string, state: Extract<StateAst, { kind: "state" }>): HyperchartInspectState {
	const action = state.action;
	const refs = actionRefs(action);
	const reads = refs.flatMap((ref) => (ref.state === undefined ? [] : [ref.state]));
	const artifacts = actionArtifacts(action);
	const inputs = inputDefinitions(state.input);
	const base = {
		id: path,
		...(reads.length === 0 ? {} : { reads: [...new Set(reads)] }),
		...(refs.length === 0 ? {} : { refs }),
		...(inputs === undefined ? {} : { inputs }),
		...(state.onReenter === undefined ? {} : { onReenter: onReenterInfo(state.onReenter) }),
		...(artifacts.length === 0 ? {} : { artifacts }),
		...(action.reply === undefined ? {} : { reply: action.reply.schema }),
		...(state.retries === undefined ? {} : { retries: state.retries }),
	};
	if (action.kind === "agent") {
		const task = templatePreview(action.task);
		return {
			...base,
			kind: "agent",
			agent: action.name,
			...(task === undefined ? {} : { task }),
			...(action.model === undefined ? {} : { model: action.model }),
			...(action.thinking === undefined ? {} : { thinking: action.thinking }),
			...(action.tools === undefined ? {} : { tools: action.tools }),
		};
	}
	if (action.kind === "script") {
		return {
			...base,
			kind: "script",
			command: [action.command, ...action.args].join(" "),
			...(action.env === undefined ? {} : { envKeys: Object.keys(action.env) }),
		};
	}
	const task = templatePreview(action.prompt);
	return { ...base, kind: "user", ...(task === undefined ? {} : { task }) };
}

function inputDefinitions(input: Readonly<Record<string, SchemaAst>> | undefined): HyperchartInspectInput[] | undefined {
	if (input === undefined) return undefined;
	const entries = Object.entries(input).map(([name, schema]) => {
		const record = schema.schema as Record<string, unknown>;
		return {
			name,
			schema: schema.schema,
			required: !("default" in record),
			...("default" in record ? { defaultValue: record.default } : {}),
		};
	});
	return entries.length === 0 ? undefined : entries;
}

function onReenterInfo(value: OnReenterAst): HyperchartInspectOnReenter {
	if (value === "restart") return { mode: "restart" };
	const refs = templateRefs(value.message);
	const message = templatePreview(value.message);
	return { mode: "resume", ...(message === undefined ? {} : { message }), ...(refs.length === 0 ? {} : { refs }) };
}

function artifactInfo(name: string, artifact: ArtifactAst): HyperchartInspectArtifact {
	const path = templatePreview(artifact.path);
	return {
		name,
		...(path === undefined ? {} : { path }),
		...(artifact.shape === undefined ? {} : { shape: artifact.shape.schema }),
	};
}

function actionArtifacts(action: StateActionAst): HyperchartInspectArtifact[] {
	if (action.kind === "user") return [];
	return Object.entries(action.artifacts ?? {}).map(([name, artifact]) => artifactInfo(name, artifact));
}

function transitionEntries(state: Exclude<StateAst, { kind: "final" }>): HyperchartInspectTransition[] {
	const entries = Object.entries(state.transitions).map(([event, transition]) => ({
		event,
		target: siblingStatePath(state.parent, transition.target),
		...(transition.input === undefined ? {} : { input: eventBindingsInfo(transition.input) }),
	}));
	if (state.kind === "compound" || state.kind === "parallel" || state.kind === "map") {
		entries.push({ event: "onDone", target: siblingStatePath(state.parent, state.onDone) });
	}
	if (state.kind === "state" && state.after !== undefined) {
		entries.push({
			event: `after:${state.after.delayMs}ms`,
			target: siblingStatePath(state.parent, state.after.target),
		});
	}
	return entries;
}

function eventBindingsInfo(input: Readonly<Record<string, EventBindingAst>>): Record<string, string> {
	return Object.fromEntries(Object.entries(input).map(([name, binding]) => [name, eventBindingPreview(binding)]));
}

function eventBindingPreview(binding: EventBindingAst): string {
	return binding.path === undefined ? "event()" : `event:${binding.path}`;
}

function siblingStatePath(parent: string | undefined, localId: string): string {
	return parent === undefined ? localId : `${parent}.${localId}`;
}

function actionRefs(action: StateActionAst): HyperchartInspectRef[] {
	const refs: HyperchartInspectRef[] = [];
	if (action.kind === "agent") {
		for (const read of action.reads ?? []) appendReadRefs(refs, read);
		appendTemplateRefs(refs, action.task);
	} else if (action.kind === "script") {
		for (const value of Object.values(action.env ?? {})) appendReadRefs(refs, value);
	} else {
		appendTemplateRefs(refs, action.prompt);
	}
	return uniqueRefs(refs);
}

function appendReadRefs(refs: HyperchartInspectRef[], value: TemplateAst | ArtifactOfAst | JoinArtifactOfAst): void {
	if (value.kind === "artifactOf" || value.kind === "joinArtifactOf") {
		const path = [value.artifact, value.kind === "artifactOf" ? value.select : undefined].filter(Boolean).join(".");
		refs.push({
			kind: value.kind,
			preview: path ? `${value.kind}:${value.state}.${path}` : `${value.kind}:${value.state}`,
			state: value.state,
			...(path === "" ? {} : { path }),
		});
		return;
	}
	appendTemplateRefs(refs, value);
}

function appendTemplateRefs(refs: HyperchartInspectRef[], value: TemplateAst | undefined): void {
	refs.push(...templateRefs(value));
}

function templateRefs(value: TemplateAst | undefined): HyperchartInspectRef[] {
	if (value === undefined) return [];
	return value.refs.map(inputRefInfo);
}

function templatePreview(value: TemplateAst | undefined): string | undefined {
	if (value === undefined) return undefined;
	const rendered = value.strings.reduce((acc, chunk, index) => {
		const ref = value.refs[index];
		return ref === undefined ? `${acc}${chunk}` : `${acc}${chunk}{${inputRefPreview(ref)}}`;
	}, "");
	return rendered.trim() || undefined;
}

function inputRefInfo(ref: InputRef): HyperchartInspectRef {
	const preview = inputRefPreview(ref);
	const common = { kind: ref.kind, preview, ...(ref.json === true ? { json: true } : {}) };
	switch (ref.kind) {
		case "arg":
			return { ...common, name: ref.name };
		case "result":
			return { ...common, state: ref.state, ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "key":
			return { ...common, ...(ref.map === undefined ? {} : { state: ref.map }) };
		case "item":
			return { ...common, ...(ref.map === undefined ? {} : { state: ref.map }), ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "input":
			return { ...common, name: ref.name, ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "visit":
			return { ...common, ...(ref.state === undefined ? {} : { state: ref.state }) };
	}
}

function inputRefPreview(ref: InputRef): string {
	switch (ref.kind) {
		case "arg":
			return `arg:${ref.name}`;
		case "result":
			return ref.path ? `${ref.state}.${ref.path}` : ref.state;
		case "key":
			return ref.map ? `${ref.map}.key` : "key";
		case "item":
			return [ref.map, "item", ref.path].filter(Boolean).join(".");
		case "input":
			return ref.path ? `input:${ref.name}.${ref.path}` : `input:${ref.name}`;
		case "visit":
			return ref.state ? `visit:${ref.state}` : "visit";
	}
}

function uniqueRefs(refs: HyperchartInspectRef[]): HyperchartInspectRef[] {
	const seen = new Set<string>();
	const unique: HyperchartInspectRef[] = [];
	for (const ref of refs) {
		const key = JSON.stringify(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}
	return unique;
}
