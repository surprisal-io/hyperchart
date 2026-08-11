import {
	ArrowPathRoundedSquareIcon,
	ArrowsRightLeftIcon,
	ChatBubbleLeftRightIcon,
	CheckBadgeIcon,
	CommandLineIcon,
	FolderIcon,
	MapIcon,
	QueueListIcon,
	PaperAirplaneIcon,
	RectangleStackIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { HyperchartRunInfo, HyperchartStateInfo, HyperchartUsageInfo } from "../../../types.js";
import type { HeroIcon } from "../types.js";

export function localStateId(stateId: string): string {
	const dot = stateId.lastIndexOf(".");
	return dot === -1 ? stateId : stateId.slice(dot + 1);
}

export function isImplicitFailedFinal(state: HyperchartStateInfo): boolean {
	return state.final === true && localStateId(state.id) === "failed";
}

export function stateDisplayName(state: HyperchartStateInfo): string {
	return localStateId(state.id);
}

export function stateKindMeta(state: HyperchartStateInfo): {
	label: string;
	Icon: HeroIcon;
	className: string;
	iconClassName: string;
} {
	switch (state.type ?? "agent") {
		case "send":
			return {
				label: "send",
				Icon: PaperAirplaneIcon,
				className: "border-teal-500/45 bg-teal-500/10 text-[var(--hc-cyan-text)]",
				iconClassName: "text-[var(--hc-cyan-text)]",
			};
		case "sendBatch":
			return {
				label: "sendBatch",
				Icon: RectangleStackIcon,
				className: "border-teal-500/45 bg-teal-500/10 text-[var(--hc-cyan-text)]",
				iconClassName: "text-[var(--hc-cyan-text)]",
			};
		case "call":
			return {
				label: "call",
				Icon: ArrowsRightLeftIcon,
				className: "border-violet-500/45 bg-violet-500/10 text-[var(--hc-purple-text)]",
				iconClassName: "text-[var(--hc-purple-text)]",
			};
		case "callBatch":
			return {
				label: "callBatch",
				Icon: ArrowPathRoundedSquareIcon,
				className: "border-violet-500/45 bg-violet-500/10 text-[var(--hc-purple-text)]",
				iconClassName: "text-[var(--hc-purple-text)]",
			};
		case "actor-declaration":
		case "actor-occurrence":
			return {
				label: "actor",
				Icon: QueueListIcon,
				className: "border-amber-500/45 bg-amber-500/10 text-[var(--hc-amber-text)]",
				iconClassName: "text-[var(--hc-amber-text)]",
			};
		case "receive":
		case "reply":
			return {
				label: state.type === "receive" ? "receive" : "reply",
				Icon: QueueListIcon,
				className: "border-amber-500/45 bg-amber-500/10 text-[var(--hc-amber-text)]",
				iconClassName: "text-[var(--hc-amber-text)]",
			};
		case "script":
			return {
				label: "script",
				Icon: CommandLineIcon,
				className: "border-slate-500/45 bg-slate-500/10 text-[var(--hc-slate-text)]",
				iconClassName: "text-[var(--hc-slate-text)]",
			};
		case "parallel":
			return {
				label: "parallel",
				Icon: ArrowsRightLeftIcon,
				className: "border-sky-500/45 bg-sky-500/10 text-[var(--hc-blue-text)]",
				iconClassName: "text-[var(--hc-blue-text)]",
			};
		case "region":
			return {
				label: "compound",
				Icon: FolderIcon,
				className: "border-indigo-500/45 bg-indigo-500/10 text-[var(--hc-indigo-text)]",
				iconClassName: "text-[var(--hc-indigo-text)]",
			};
		case "compound":
			return {
				label: "compound",
				Icon: FolderIcon,
				className: "border-indigo-500/45 bg-indigo-500/10 text-[var(--hc-indigo-text)]",
				iconClassName: "text-[var(--hc-indigo-text)]",
			};
		case "final":
			return {
				label: "final",
				Icon: CheckBadgeIcon,
				className: "border-green-500/45 bg-green-500/10 text-[var(--hc-green-text)]",
				iconClassName: "text-[var(--hc-green-text)]",
			};
		case "map":
			return {
				label: "map",
				Icon: MapIcon,
				className: "border-cyan-500/45 bg-cyan-500/10 text-[var(--hc-cyan-text)]",
				iconClassName: "text-[var(--hc-cyan-text)]",
			};
		case "user":
			return {
				label: "user",
				Icon: ChatBubbleLeftRightIcon,
				className: "border-pink-500/45 bg-pink-500/10 text-[var(--hc-pink-text)]",
				iconClassName: "text-[var(--hc-pink-text)]",
			};
		default:
			return {
				label: "agent",
				Icon: UserCircleIcon,
				className: "border-blue-500/45 bg-blue-500/10 text-[var(--hc-blue-text)]",
				iconClassName: "text-[var(--hc-blue-text)]",
			};
	}
}

export function formatStateDuration(state: HyperchartStateInfo, snapshotAt = Date.now()): string | undefined {
	if (state.startedAt === undefined) return undefined;
	const end = state.endedAt ?? snapshotAt;
	const seconds = Math.max(0, Math.round((end - state.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function compactCost(value: number): string {
	return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function formatCompactUsage(usage?: HyperchartUsageInfo): string | undefined {
	if (!usage || typeof usage.cost !== "number" || usage.cost <= 0) return undefined;
	return compactCost(usage.cost);
}

export function stateConcurrencyLabel(state: HyperchartStateInfo): string | undefined {
	if (state.concurrency !== undefined) return `concurrency ×${state.concurrency}`;
	if ((state.type ?? "agent") === "parallel") {
		const regions = state.subProgress?.total ?? state.parallelConfig?.count ?? state.parallelConfig?.branches?.length;
		return regions !== undefined && regions > 0 ? `concurrency ×${regions}` : undefined;
	}
	return undefined;
}

export function stateMechanismLabel(state: HyperchartStateInfo): string | undefined {
	switch (state.type ?? "agent") {
		case "agent":
			return state.agent ? `@${state.agent}` : "agent";
		case "send":
		case "call":
			return state.taskPreview;
		case "sendBatch":
		case "callBatch":
			return `${state.type} · ${state.taskPreview ?? "message batch"}`;
		case "actor-declaration":
			return `${state.actorDeclaration?.protocol.length ?? 0} messages`;
		case "actor-occurrence":
			return `${state.actorOccurrence?.currentState ?? "idle"} · mailbox ${state.actorOccurrence?.mailbox.totalCount ?? 0}`;
		case "receive":
			return "receive()";
		case "reply":
			return "reply()";
		case "script":
			return state.commandPreview?.split("\n")[0] ?? "script";
		case "map": {
			const progress = state.subProgress;
			if (progress)
				return [
					`${progress.done} done`,
					`${progress.running} running`,
					progress.waiting ? `${progress.waiting} waiting` : undefined,
					`${progress.failed} failed`,
					progress.stale ? `${progress.stale} stale` : undefined,
					`/ ${progress.total}`,
				]
					.filter(Boolean)
					.join(" · ");
			const count = state.mapConfig?.items?.length;
			return count === undefined ? "map" : `${count} items`;
		}
		case "parallel": {
			const count = state.parallelConfig?.count ?? state.parallelConfig?.branches?.length;
			return `${count ?? "dynamic"} branches`;
		}
		case "compound":
			return "compound";
		case "region":
			return "compound";
		case "final":
			return "terminal";
		case "user":
			return undefined;
	}
}

export function compactRuntimeFacts(state: HyperchartStateInfo): string[] {
	return [
		state.visits !== undefined && state.visits > 1 ? `visits ×${state.visits}` : undefined,
		formatCompactUsage(state.usage),
	].filter((fact): fact is string => Boolean(fact));
}

export function compactTriageFacts(_state: HyperchartStateInfo, validationLabel: string | undefined): string[] {
	return [validationLabel].filter((fact): fact is string => Boolean(fact));
}

export function compactFactClass(fact: string): string {
	if (fact.startsWith("validation")) return "bg-amber-500/10 px-1.5 py-0.5 text-[var(--hc-amber-text)]";
	return "text-[var(--text-tertiary)]";
}

export function validationRetryLabel(state: HyperchartStateInfo): string | undefined {
	if (state.retry?.max === undefined && state.validationAttempts === undefined) return undefined;
	const max = state.retry?.max;
	const attempts = state.validationAttempts;
	if (attempts !== undefined && max !== undefined) return `validation ×${attempts}/${max}`;
	if (attempts !== undefined) return `validation ×${attempts}`;
	return max !== undefined ? `validation retry ≤${max}` : undefined;
}

export function agentStatesForSelection(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
): HyperchartStateInfo[] {
	if (state.agent) return [state];
	const childPrefix = `${state.id}.`;
	const mapInstancePrefix = `${state.id}#`;
	const seenAgents = new Set<string>();
	return allStates.filter((candidate) => {
		if (
			!candidate.agent ||
			(!candidate.id.startsWith(childPrefix) && !(state.type === "map" && candidate.id.startsWith(mapInstancePrefix))) ||
			seenAgents.has(candidate.agent)
		) {
			return false;
		}
		seenAgents.add(candidate.agent);
		return true;
	});
}

export function stateHasContracts(state: HyperchartStateInfo): boolean {
	return (state.artifacts?.length ?? 0) > 0 || Boolean(state.replySchema);
}

export function stateHasRuntimeDetails(state: HyperchartStateInfo): boolean {
	return (
		state.startedAt !== undefined ||
		state.endedAt !== undefined ||
		Boolean(state.mapItemLabel) ||
		state.visits !== undefined ||
		state.visitHistory !== undefined ||
		state.subProgress !== undefined ||
		state.mapConfig?.items !== undefined ||
		Boolean(state.usage) ||
		state.session !== undefined ||
		state.actorOccurrence !== undefined ||
		state.actorInternal?.generations !== undefined ||
		state.actorMessageHistory !== undefined ||
		state.actorMessageLink?.messages !== undefined
	);
}

export function contractStatesForSelection(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
	highlightedReply?: { stateId: string; path: string } | null,
	revealedReplyStateIds: readonly string[] = [],
): HyperchartStateInfo[] {
	if (state.type === "compound" && !stateHasContracts(state)) return [];
	const prefix = `${state.id}.`;
	const selected = stateHasContracts(state)
		? [state]
		: allStates.filter((candidate) => candidate.id.startsWith(prefix) && stateHasContracts(candidate));
	const extraIds = new Set(revealedReplyStateIds);
	if (highlightedReply) extraIds.add(highlightedReply.stateId);
	const extras = [...extraIds]
		.map((stateId) => allStates.find((candidate) => candidate.id === stateId && stateHasContracts(candidate)))
		.filter(
			(candidate): candidate is HyperchartStateInfo =>
				candidate !== undefined && !selected.some((selectedState) => selectedState.id === candidate.id),
		);
	return [...selected, ...extras];
}

export function hyperchartRunTitle(run: HyperchartRunInfo): string {
	const topic = typeof run.args?.topic === "string" ? run.args.topic : undefined;
	return [run.runId, topic].filter(Boolean).join("\n");
}
