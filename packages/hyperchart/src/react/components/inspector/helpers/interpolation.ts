import type { HyperchartStateInfo } from "../../../types.js";
import type { PromptInterpolationAction, PromptInterpolationRef, PromptInterpolationTone } from "../types.js";
import { parseDslCallArgs, stateInputRefSchema } from "./dslRefs.js";
import { schemaAtPath, schemaTypeText } from "./schema.js";

function unwrapDslCall(token: string, name: string): string | undefined {
	const trimmed = token.trim();
	const prefix = `${name}(`;
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith(")")) {
		return undefined;
	}
	const inner = trimmed.slice(prefix.length, -1).trim();
	return inner.length === 0 ? undefined : inner;
}

function parsePromptInterpolationRef(token: string): PromptInterpolationRef {
	const sourceToken = unwrapDslCall(token, "json") ?? token;
	const inputArgs = parseDslCallArgs(sourceToken, "input");
	if (inputArgs?.[0]) {
		return { kind: "input", name: inputArgs[0], ...(inputArgs[1] === undefined ? {} : { path: inputArgs[1] }) };
	}
	const actorInputArgs = parseDslCallArgs(sourceToken, "actorInput");
	if (actorInputArgs) {
		return { kind: "actorInput", ...(actorInputArgs[0] === undefined ? {} : { path: actorInputArgs[0] }) };
	}
	const messageInputArgs = parseDslCallArgs(sourceToken, "messageInput");
	if (messageInputArgs?.[0]) {
		return {
			kind: "messageInput",
			message: messageInputArgs[0],
			...(messageInputArgs[1] === undefined ? {} : { path: messageInputArgs[1] }),
		};
	}
	const resultArgs = parseDslCallArgs(sourceToken, "result");
	if (resultArgs?.[0]) {
		return { kind: "result", state: resultArgs[0], ...(resultArgs[1] === undefined ? {} : { path: resultArgs[1] }) };
	}
	const visitArgs = parseDslCallArgs(sourceToken, "visit");
	if (visitArgs) {
		return { kind: "visit", ...(visitArgs[0] === undefined ? {} : { state: visitArgs[0] }) };
	}
	const keyArgs = parseDslCallArgs(sourceToken, "key");
	if (keyArgs) {
		return { kind: "key", ...(keyArgs[0] === undefined ? {} : { state: keyArgs[0] }) };
	}
	return { kind: "unknown" };
}

function resultRefTarget(
	ref: PromptInterpolationRef,
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
): { state: HyperchartStateInfo; path?: string } | undefined {
	if (ref.kind !== "result") {
		return undefined;
	}
	const direct = allStates.find((candidate) => candidate.id === ref.state && candidate.replySchema !== undefined);
	const actorInternal = state.actorInternal;
	const actorLocal =
		actorInternal === undefined
			? undefined
			: (allStates.find((candidate) => {
					const target = candidate.actorInternal;
					if (
						target?.declarationPath !== actorInternal.declarationPath ||
						target.localState !== ref.state ||
						candidate.replySchema === undefined
					) {
						return false;
					}
					if (actorInternal.occurrencePath !== undefined && target.occurrencePath !== actorInternal.occurrencePath) {
						return false;
					}
					if (
						actorInternal.logicalOccurrencePath !== undefined &&
						target.logicalOccurrencePath !== actorInternal.logicalOccurrencePath
					) {
						return false;
					}
					return actorInternal.generation === undefined || target.generation === actorInternal.generation;
				}) ??
				allStates.find(
					(candidate) =>
						candidate.actorInternal?.declarationPath === actorInternal.declarationPath &&
						candidate.actorInternal.localState === ref.state &&
						candidate.replySchema !== undefined,
				));
	const target = actorInternal === undefined ? direct : actorLocal;
	return target === undefined ? undefined : { state: target, ...(ref.path === undefined ? {} : { path: ref.path }) };
}

function inputRefTypeInfo(
	state: HyperchartStateInfo,
	ref: PromptInterpolationRef,
): { name: string; schema?: HyperchartStateInfo["replySchema"] } | undefined {
	if (ref.kind !== "input") {
		return undefined;
	}
	const schema = stateInputRefSchema(state, ref.name, ref.path);
	return { name: ref.name, ...(schema === undefined ? {} : { schema }) };
}

function actorDeclarationForState(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
): NonNullable<HyperchartStateInfo["actorDeclaration"]> | undefined {
	const declarationPath = state.actorInternal?.declarationPath;
	if (declarationPath === undefined) {
		return undefined;
	}
	return allStates.find((candidate) => candidate.actorDeclaration?.declarationPath === declarationPath)
		?.actorDeclaration;
}

function actorLocalRefTypeInfo(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
	ref: PromptInterpolationRef,
): { schema?: HyperchartStateInfo["replySchema"]; tone: "actorInput" | "messageInput" } | undefined {
	const declaration = actorDeclarationForState(state, allStates);
	if (ref.kind === "actorInput") {
		const schema = declaration?.inputSchema;
		return {
			tone: "actorInput",
			...(schema === undefined ? {} : { schema: schemaAtPath(schema, ref.path) ?? schema }),
		};
	}
	if (ref.kind === "messageInput") {
		const schema = declaration?.protocol.find((message) => message.event === ref.message)?.input;
		return {
			tone: "messageInput",
			...(schema === undefined ? {} : { schema: schemaAtPath(schema, ref.path) ?? schema }),
		};
	}
	return undefined;
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
	const actorLocalInfo = actorLocalRefTypeInfo(state, allStates, ref);
	if (actorLocalInfo) {
		return {
			title: actorLocalInfo.schema ? schemaTypeText(actorLocalInfo.schema) : "unknown",
			tone: actorLocalInfo.tone,
		};
	}
	const inputInfo = inputRefTypeInfo(state, ref);
	if (inputInfo) {
		return {
			title: inputInfo.schema ? schemaTypeText(inputInfo.schema) : "unknown",
			tone: "input",
			...(actions.onHighlightInput === undefined ? {} : { onClick: () => actions.onHighlightInput?.(inputInfo.name) }),
		};
	}
	if (ref.kind === "visit") {
		return { title: "number", tone: "visit" };
	}
	const resultTarget = resultRefTarget(ref, state, allStates);
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
	if (ref.kind === "key") {
		return { title: "string", tone: "plain" };
	}
	return { title: token, tone: "plain" };
}

export function interpolationTokenClass(tone: PromptInterpolationTone, clickable: boolean): string {
	const base =
		"mx-0.5 inline-flex max-w-full items-center overflow-x-auto whitespace-nowrap rounded border px-1 py-0.5 align-baseline font-mono text-left leading-[1.35]";
	const interaction = clickable ? "cursor-pointer" : "cursor-help";
	switch (tone) {
		case "input":
			return `${base} ${interaction} border-cyan-500/25 bg-cyan-500/10 text-[var(--hc-cyan-text)] hover:bg-cyan-500/15`;
		case "actorInput":
			return `${base} ${interaction} border-purple-500/25 bg-purple-500/10 text-[var(--hc-purple-text)] hover:bg-purple-500/15`;
		case "messageInput":
			return `${base} ${interaction} border-blue-500/25 bg-blue-500/10 text-[var(--hc-blue-text)] hover:bg-blue-500/15`;
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
		if (isPromptInterpolationToken(match[1] ?? "")) {
			return true;
		}
	}
	return false;
}
