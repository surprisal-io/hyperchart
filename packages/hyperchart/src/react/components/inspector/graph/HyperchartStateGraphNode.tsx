import { useEffect, useState } from "react";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { hyperchartStatusClasses, hyperchartStatusDotClass } from "../../../hyperchart-display.js";
import type { StateNode } from "../types.js";
import {
	compactFactClass,
	compactRuntimeFacts,
	compactTriageFacts,
	formatStateDuration,
	stateDisplayName,
	stateKindMeta,
	stateMechanismLabel,
	validationRetryLabel,
} from "../helpers/state.js";
import { graphNodeSize } from "./graphModel.js";
import { CompactMapNodePreview } from "./CompactMapNodePreview.js";
import { CompactParallelNodePreview } from "./CompactParallelNodePreview.js";
import { ActorNodePreview } from "./ActorNodePreview.js";

function useDurationSnapshot(active: boolean, snapshotAt?: number): number | undefined {
	const [current, setCurrent] = useState(() => snapshotAt ?? Date.now());
	useEffect(() => {
		if (!active) return;
		const baseline = snapshotAt ?? Date.now();
		const mountedAt = Date.now();
		setCurrent(baseline);
		const timer = window.setInterval(() => setCurrent(baseline + Date.now() - mountedAt), 1_000);
		return () => window.clearInterval(timer);
	}, [active, snapshotAt]);
	return active ? current : snapshotAt;
}

export function HyperchartStateGraphNode({ data, selected }: NodeProps<StateNode>) {
	const state = data.state;
	const displayState = data.displayType ? { ...state, type: data.displayType } : state;
	const kind = stateKindMeta(displayState);
	const KindIcon = kind.Icon;
	const validationLabel = validationRetryLabel(state);
	const hasStructuredPreview =
		displayState.type === "map" ||
		displayState.type === "parallel" ||
		displayState.type === "actor-declaration" ||
		displayState.type === "actor-occurrence";
	const mechanism = hasStructuredPreview ? undefined : stateMechanismLabel(displayState);
	const actorMessage = displayState.type === "send" || displayState.type === "sendBatch" || displayState.type === "call" || displayState.type === "callBatch"
		? displayState.actorMessageLink
		: undefined;
	const durationSnapshot = useDurationSnapshot(
		state.status === "running" && state.startedAt !== undefined && state.endedAt === undefined,
		data.snapshotAt,
	);
	const duration = formatStateDuration(state, durationSnapshot);
	const displayedStatus = displayState.type === "actor-declaration" && state.actorOccurrence === undefined
		? "definition-only"
		: state.status;
	const runtimeChips = compactRuntimeFacts(state).slice(0, 2);
	const triageChips = compactTriageFacts(state, validationLabel).slice(0, 2);
	const outlineClass = selected
		? "border-blue-400 ring-2 ring-blue-500/30"
		: state.status === "failed"
			? "border-red-500/45 shadow-red-950/20 ring-1 ring-red-500/15"
			: state.status === "running"
				? "border-blue-500/30 shadow-blue-950/15"
				: state.status === "done"
					? "border-green-500/25 shadow-green-950/10"
					: state.status === "waiting" || state.status === "stale"
						? "border-amber-500/35 shadow-amber-950/10 ring-1 ring-amber-500/10"
						: displayState.type === "map"
							? "border-cyan-400/70 shadow-cyan-950/20 ring-1 ring-cyan-500/15"
							: displayState.type === "parallel"
								? "border-sky-400/45 shadow-sky-950/15"
								: "border-transparent";
	const size = graphNodeSize(displayState);
	const isActorPool = state.actorOccurrence?.kind === "actorPool" || state.actorDeclaration?.kind === "actorPool";
	const handleClass = "!h-px !w-px !border-0 !bg-transparent !opacity-0";
	const handleStyle = { background: "transparent", border: 0, opacity: 0, width: 1, height: 1 };
	return (
		<div className="relative" style={{ width: size.width, height: size.height }}>
			{isActorPool && (
				<>
					<div className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-amber-500/15 bg-[var(--bg-tertiary)] shadow-md" aria-hidden="true" />
					<div className="pointer-events-none absolute inset-0 translate-x-1 translate-y-1 rounded-xl border border-amber-500/20 bg-[var(--bg-secondary)] shadow-md" aria-hidden="true" />
				</>
			)}
			<div className={`absolute inset-0 z-10 overflow-hidden rounded-xl border bg-[var(--bg-secondary)] shadow-lg ${outlineClass}`}>
			<div
				className={`absolute inset-x-0 top-0 h-1 ${hyperchartStatusDotClass(state.status)} ${state.status === "running" ? "animate-pulse" : ""}`}
				aria-hidden="true"
			/>
			<Handle id="target-left" type="target" position={Position.Left} className={handleClass} style={handleStyle} />
			<Handle id="source-left" type="source" position={Position.Left} className={handleClass} style={handleStyle} />
			<Handle
				id="target-top"
				type="target"
				position={Position.Top}
				className={handleClass}
				style={{ ...handleStyle, left: "48%" }}
			/>
			<Handle
				id="source-top"
				type="source"
				position={Position.Top}
				className={handleClass}
				style={{ ...handleStyle, left: "52%" }}
			/>

			<div className="flex h-full min-w-0 flex-col px-3 pb-5 pt-3">
				<div className="flex min-w-0 items-center gap-1.5">
					<KindIcon className={`h-3.5 w-3.5 shrink-0 ${kind.iconClassName}`} aria-hidden="true" />
					<div
						className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[var(--text-primary)]"
						title={state.id}
					>
						{stateDisplayName(state)}
					</div>
					{state.initial === true && (
						<span
							className="inline-flex shrink-0 rounded border border-violet-500/35 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--hc-purple-text)]"
							title="Initial state"
						>
							initial
						</span>
					)}
					<span
						className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${hyperchartStatusClasses(state.status)}`}
					>
						<span className={`h-1.5 w-1.5 rounded-full ${hyperchartStatusDotClass(state.status)}`} /> {displayedStatus}
					</span>
				</div>

				{(mechanism !== undefined || (!hasStructuredPreview && displayState.type !== "user")) && (
					<div className="mt-2 flex min-w-0 items-center gap-2 text-[10px]">
						{actorMessage !== undefined ? (
							<div className="flex min-w-0 items-center font-mono text-[10px] leading-none text-[var(--text-secondary)]">
								<EnvelopeIcon className="mr-1 h-2.5 w-2.5 shrink-0 text-[var(--text-muted)]" aria-label="Event" title="Event" />
								<span className="truncate text-[var(--text-primary)]" title={actorMessage.event}>{actorMessage.event}</span>
								<span className="mx-1.5 text-[var(--text-muted)]" aria-hidden="true">→</span>
								<span className="truncate" title={actorMessage.to}>{actorMessage.to}</span>
							</div>
						) : !hasStructuredPreview ? (
							<div className="min-w-0 truncate font-mono text-[var(--text-secondary)]" title={mechanism ?? kind.label}>
								{mechanism ?? kind.label}
							</div>
						) : null}
					</div>
				)}

				{displayState.type === "map" && <CompactMapNodePreview state={displayState} />}
				{displayState.type === "parallel" && <CompactParallelNodePreview state={displayState} />}
				{(displayState.type === "actor-declaration" || displayState.type === "actor-occurrence") && (
					<ActorNodePreview state={displayState} />
				)}
			</div>

			{triageChips.length > 0 && (
				<div className="pointer-events-none absolute bottom-7 left-3 right-3 flex min-w-0 gap-1 overflow-hidden text-[9px]">
					{triageChips.map((fact) => (
						<span
							key={fact}
							className={`min-w-0 max-w-[132px] truncate rounded ${compactFactClass(fact)}`}
							title={fact}
						>
							{fact}
						</span>
					))}
				</div>
			)}
			{runtimeChips.length > 0 && (
				<div className="pointer-events-none absolute bottom-2 left-3 right-20 flex min-w-0 gap-1 overflow-hidden text-[9px]">
					{runtimeChips.map((fact) => (
						<span
							key={fact}
							className={`min-w-0 max-w-[142px] truncate rounded ${compactFactClass(fact)}`}
							title={fact}
						>
							{fact}
						</span>
					))}
				</div>
			)}
			{duration && (
				<div
					className="pointer-events-none absolute bottom-2 right-3 max-w-[68px] truncate text-right font-mono text-[9px] text-[var(--text-muted)]"
					title={duration}
				>
					{duration}
				</div>
			)}

			<Handle id="target-right" type="target" position={Position.Right} className={handleClass} style={handleStyle} />
			<Handle id="source-right" type="source" position={Position.Right} className={handleClass} style={handleStyle} />
			<Handle
				id="target-bottom"
				type="target"
				position={Position.Bottom}
				className={handleClass}
				style={{ ...handleStyle, left: "48%" }}
			/>
			<Handle
				id="source-bottom"
				type="source"
				position={Position.Bottom}
				className={handleClass}
				style={{ ...handleStyle, left: "52%" }}
			/>
			</div>
		</div>
	);
}
