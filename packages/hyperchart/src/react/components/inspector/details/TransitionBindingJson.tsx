import type { ReactNode } from "react";
import type {
	HyperchartInspectRef,
	HyperchartInspectValue,
	HyperchartLaunchArgumentInfo,
	HyperchartStateInfo,
} from "../../../types.js";
import type { TransitionBindingDisplay } from "../types.js";
import {
	transitionBindingDisplay,
	transitionBindingLabel,
	transitionBindingResultTarget,
	transitionBindingTitle,
} from "../helpers/transitions.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

const REF_KINDS = new Set<HyperchartInspectRef["kind"]>([
	"arg",
	"result",
	"key",
	"item",
	"input",
	"visit",
	"actorInput",
	"messageInput",
	"artifactOf",
	"joinArtifactOf",
	"joinResultOf",
]);

function isInspectRef(value: HyperchartInspectValue): value is HyperchartInspectRef {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"kind" in value &&
		REF_KINDS.has(value.kind as HyperchartInspectRef["kind"]) &&
		"preview" in value &&
		typeof value.preview === "string"
	);
}

type BindingActions = {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	visibleReplyStateIds: readonly string[];
	onReplyFieldClick?: (path: string) => void;
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onNavigateToState?: (stateId: string) => void;
};

function bindingClick(binding: TransitionBindingDisplay, actions: BindingActions): (() => void) | undefined {
	if (binding.kind === "event" && binding.path !== undefined && actions.onReplyFieldClick !== undefined) {
		return () => actions.onReplyFieldClick?.(binding.path ?? "");
	}
	if (binding.kind === "input" && binding.name !== undefined && actions.onHighlightInput !== undefined) {
		return () => actions.onHighlightInput?.(binding.name ?? "");
	}
	if (binding.kind === "result" || binding.kind === "joinResultOf") {
		const target = transitionBindingResultTarget(actions.state, actions.allStates, binding);
		if (target !== undefined) {
			const visible = actions.visibleReplyStateIds.includes(target.state.id);
			if (visible && actions.onHighlightReply !== undefined) {
				return () => actions.onHighlightReply?.(target.state.id, target.path ?? "");
			}
			if (!visible && actions.onNavigateToState !== undefined) {
				return () => actions.onNavigateToState?.(target.state.id);
			}
			if (actions.onHighlightReply !== undefined) {
				return () => actions.onHighlightReply?.(target.state.id, target.path ?? "");
			}
		}
	}
	if (binding.kind !== "event" && binding.kind !== "unknown" && actions.onHighlightRef !== undefined) {
		return () => actions.onHighlightRef?.(binding.preview);
	}
	return undefined;
}

function BindingChip({ binding, actions }: { binding: TransitionBindingDisplay; actions: BindingActions }) {
	const value = transitionBindingLabel(binding);
	const onClick = bindingClick(binding, actions);
	return (
		<TypeTooltip text={transitionBindingTitle(actions.state, binding, actions.allStates, actions.launchArgs)}>
			{onClick === undefined ? (
				<span className="rounded border border-cyan-500/25 bg-cyan-500/10 px-1 text-[var(--hc-cyan-text)]">
					{value}
				</span>
			) : (
				<button
					type="button"
					onClick={onClick}
					className="rounded border border-cyan-500/25 bg-cyan-500/10 px-1 text-left text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
				>
					{value}
				</button>
			)}
		</TypeTooltip>
	);
}

type JsonLine = { key: string; depth: number; content: ReactNode };

function primitiveNode(value: null | string | number | boolean): ReactNode {
	if (typeof value === "string") {
		return <span className="text-amber-300">{JSON.stringify(value)}</span>;
	}
	if (value === null) {
		return <span className="text-fuchsia-300">null</span>;
	}
	return <span className="text-blue-300">{String(value)}</span>;
}

function appendValueLines(
	lines: JsonLine[],
	value: HyperchartInspectValue,
	depth: number,
	key: string,
	prefix: ReactNode,
	suffix: string,
	actions: BindingActions,
	parseStringBindings: boolean,
): void {
	if (isInspectRef(value)) {
		lines.push({
			key,
			depth,
			content: (
				<>
					{prefix}
					<span className="inline-flex whitespace-nowrap">
						<BindingChip binding={transitionBindingDisplay(value)} actions={actions} />
						{suffix}
					</span>
				</>
			),
		});
		return;
	}
	if (typeof value === "string" && parseStringBindings) {
		lines.push({
			key,
			depth,
			content: (
				<>
					{prefix}
					<span className="inline-flex whitespace-nowrap">
						<BindingChip binding={transitionBindingDisplay(value)} actions={actions} />
						{suffix}
					</span>
				</>
			),
		});
		return;
	}
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		lines.push({
			key,
			depth,
			content: (
				<>
					{prefix}
					{primitiveNode(value)}
					{suffix}
				</>
			),
		});
		return;
	}
	const entries = Array.isArray(value)
		? value.map((child, index) => [String(index), child] as const)
		: Object.entries(value);
	const opening = Array.isArray(value) ? "[" : "{";
	const closing = Array.isArray(value) ? "]" : "}";
	lines.push({
		key: `${key}:open`,
		depth,
		content: (
			<>
				{prefix}
				{opening}
			</>
		),
	});
	entries.forEach(([name, child], index) => {
		appendValueLines(
			lines,
			child,
			depth + 1,
			`${key}.${name}`,
			Array.isArray(value) ? null : (
				<>
					<span className="text-red-400">{JSON.stringify(name)}</span>
					<span>: </span>
				</>
			),
			index < entries.length - 1 ? "," : "",
			actions,
			parseStringBindings,
		);
	});
	lines.push({ key: `${key}:close`, depth, content: `${closing}${suffix}` });
}

export function TransitionBindingJson({
	state,
	allStates = [state],
	launchArgs,
	input,
	parseStringBindings = false,
	visibleReplyStateIds = [state.id],
	onReplyFieldClick,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	onNavigateToState,
}: {
	state: HyperchartStateInfo;
	allStates?: HyperchartStateInfo[];
	launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	input: HyperchartInspectValue;
	parseStringBindings?: boolean;
	visibleReplyStateIds?: readonly string[];
	onReplyFieldClick?: (path: string) => void;
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onNavigateToState?: (stateId: string) => void;
}) {
	const lines: JsonLine[] = [];
	const actions: BindingActions = {
		state,
		allStates,
		...(launchArgs === undefined ? {} : { launchArgs }),
		visibleReplyStateIds,
		...(onReplyFieldClick === undefined ? {} : { onReplyFieldClick }),
		...(onHighlightInput === undefined ? {} : { onHighlightInput }),
		...(onHighlightReply === undefined ? {} : { onHighlightReply }),
		...(onHighlightRef === undefined ? {} : { onHighlightRef }),
		...(onNavigateToState === undefined ? {} : { onNavigateToState }),
	};
	appendValueLines(lines, input, 0, "$", null, "", actions, parseStringBindings);
	return (
		<div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
			{lines.map((line) => (
				<div key={line.key} style={{ paddingLeft: `${line.depth}rem` }}>
					{line.content}
				</div>
			))}
		</div>
	);
}
