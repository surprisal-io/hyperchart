import type { HyperchartStateInfo } from "../../../types.js";
import type { PromptInterpolationAction, PromptInterpolationRef, PromptInterpolationTone } from "../types.js";
import { schemaAtPath, schemaTypeText } from "./schema.js";

function parseDslCallArgs(token: string, name: string): string[] | undefined {
	const trimmed = token.trim();
	const prefix = `${name}(`;
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith(")")) return undefined;
	const body = trimmed.slice(prefix.length, -1).trim();
	if (body.length === 0) return [];
	const args: string[] = [];
	let rest = body;
	while (rest.length > 0) {
		const match = /^"((?:\\.|[^"\\])*)"\s*(?:,\s*|$)/.exec(rest);
		if (!match) return undefined;
		args.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
		rest = rest.slice(match[0].length);
	}
	return args;
}

function unwrapDslCall(token: string, name: string): string | undefined {
	const trimmed = token.trim();
	const prefix = `${name}(`;
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith(")")) return undefined;
	const inner = trimmed.slice(prefix.length, -1).trim();
	return inner.length === 0 ? undefined : inner;
}

function parsePromptInterpolationRef(token: string): PromptInterpolationRef {
	const sourceToken = unwrapDslCall(token, "json") ?? token;
	const inputArgs = parseDslCallArgs(sourceToken, "input");
	if (inputArgs?.[0])
		return { kind: "input", name: inputArgs[0], ...(inputArgs[1] === undefined ? {} : { path: inputArgs[1] }) };
	const resultArgs = parseDslCallArgs(sourceToken, "result");
	if (resultArgs?.[0])
		return { kind: "result", state: resultArgs[0], ...(resultArgs[1] === undefined ? {} : { path: resultArgs[1] }) };
	const visitArgs = parseDslCallArgs(sourceToken, "visit");
	if (visitArgs) return { kind: "visit", ...(visitArgs[0] === undefined ? {} : { state: visitArgs[0] }) };
	const keyArgs = parseDslCallArgs(sourceToken, "key");
	if (keyArgs) return { kind: "key", ...(keyArgs[0] === undefined ? {} : { state: keyArgs[0] }) };
	return { kind: "unknown" };
}

function resultRefTarget(
	ref: PromptInterpolationRef,
	allStates: HyperchartStateInfo[],
): { state: HyperchartStateInfo; path?: string } | undefined {
	if (ref.kind !== "result") return undefined;
	const state = allStates.find((candidate) => candidate.id === ref.state && candidate.replySchema !== undefined);
	return state === undefined ? undefined : { state, ...(ref.path === undefined ? {} : { path: ref.path }) };
}

function inputRefTypeInfo(
	state: HyperchartStateInfo,
	ref: PromptInterpolationRef,
): { name: string; schema?: HyperchartStateInfo["replySchema"] } | undefined {
	if (ref.kind !== "input") return undefined;
	const input = state.inputs?.find((candidate) => candidate.name === ref.name);
	if (!input?.schema) return { name: ref.name };
	return { name: ref.name, schema: schemaAtPath(input.schema, ref.path) ?? input.schema };
}

export function isPromptInterpolationToken(token: string): boolean {
	return parsePromptInterpolationRef(token).kind !== "unknown";
}

export function interpolationAction(
	token: string,
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
	actions: {
		onHighlightInput?: (name: string) => void;
		onHighlightReply?: (stateId: string, path: string) => void;
		onHighlightRef?: (value: string) => void;
	},
): PromptInterpolationAction {
	const ref = parsePromptInterpolationRef(token);
	const inputInfo = inputRefTypeInfo(state, ref);
	if (inputInfo) {
		return {
			title: inputInfo.schema ? schemaTypeText(inputInfo.schema) : "unknown",
			tone: "input",
			...(actions.onHighlightInput === undefined ? {} : { onClick: () => actions.onHighlightInput?.(inputInfo.name) }),
		};
	}
	if (ref.kind === "visit") {
		return {
			title: "number",
			tone: "visit",
			...(actions.onHighlightRef === undefined ? {} : { onClick: () => actions.onHighlightRef?.(token) }),
		};
	}
	const resultTarget = resultRefTarget(ref, allStates);
	if (resultTarget) {
		const schema = schemaAtPath(resultTarget.state.replySchema, resultTarget.path);
		return {
			title: schema ? schemaTypeText(schema) : "unknown",
			tone: "result",
			...(actions.onHighlightReply === undefined
				? {}
				: { onClick: () => actions.onHighlightReply?.(resultTarget.state.id, resultTarget.path ?? "") }),
		};
	}
	if (ref.kind === "key") return { title: "string", tone: "plain" };
	return { title: token, tone: "plain" };
}

export function interpolationTokenClass(tone: PromptInterpolationTone, clickable: boolean): string {
	const base =
		"mx-0.5 inline-block max-w-full overflow-x-auto whitespace-nowrap rounded border px-1 align-baseline font-mono text-left";
	const interaction = clickable ? "cursor-pointer" : "cursor-help";
	switch (tone) {
		case "input":
			return `${base} ${interaction} border-cyan-500/25 bg-cyan-500/10 text-[var(--hc-cyan-text)] hover:bg-cyan-500/15`;
		case "result":
			return `${base} ${interaction} border-emerald-500/25 bg-emerald-500/10 text-[var(--hc-green-text)] hover:bg-emerald-500/15`;
		case "visit":
			return `${base} ${interaction} border-amber-500/25 bg-amber-500/10 text-[var(--hc-amber-text)] hover:bg-amber-500/15`;
		case "plain":
			return `${base} ${interaction} border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]`;
	}
}

export function hasInterpolation(text: string): boolean {
	for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
		if (isPromptInterpolationToken(match[1] ?? "")) return true;
	}
	return false;
}
