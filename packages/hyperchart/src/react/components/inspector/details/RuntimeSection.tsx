import { useState } from "react";
import { BoltIcon, CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { formatHyperchartDateTime, formatHyperchartUsage } from "../../../hyperchart-display.js";
import { stateHasRuntimeDetails } from "../helpers/state.js";
import { FanoutStatusCard } from "../graph/FanoutStatusCard.js";
import { Section } from "../ui/Section.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";
import { MapResolvedInputList } from "./MapResolvedInputList.js";
import { MapVisitHistory } from "./MapVisitHistory.js";
import { VisitHistory } from "./VisitHistory.js";

export function RuntimeSection({
	state,
	onSteerSession,
}: {
	state: HyperchartStateInfo;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
}) {
	const [openSessionIdentity, setOpenSessionIdentity] = useState<string>();
	const session = state.session;
	const sessionIdentity = `${state.id}:${session?.actionKey ?? "none"}:${session?.startedAt ?? "unknown"}`;
	if (!stateHasRuntimeDetails(state)) return null;
	const sessionIsLive = session?.status === "running" || session?.status === "starting";
	return (
		<>
			<Section
				key={`runtime:${sessionIdentity}`}
				title="Runtime"
				icon={BoltIcon}
				defaultOpen={sessionIsLive}
				forceOpen={sessionIsLive}
			>
				{session !== undefined && (
					<div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-2">
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div className="min-w-0 flex-1">
								<div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--hc-cyan-text)]">
									<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> Agent session
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
									<span className="inline-flex items-center gap-1">
										<span
											className={`h-1.5 w-1.5 rounded-full ${sessionIsLive ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`}
										/>
										{session.status}
									</span>
									{session.role !== undefined && <span>role {session.role}</span>}
									{session.model !== undefined && (
										<span className="max-w-full truncate" title={session.model}>
											{session.model}
										</span>
									)}
									{session.thinking !== undefined && <span>think {session.thinking}</span>}
									{session.toolset !== undefined && <span>toolset {session.toolset}</span>}
									{session.tools !== undefined && (
										<span title={session.tools.join(", ")}>{session.tools.length} enabled tools</span>
									)}
									{session.turnCount !== undefined && <span>{session.turnCount} turns</span>}
									{session.toolCount !== undefined && <span>{session.toolCount} tools</span>}
									{session.tokenCount !== undefined && <span>{session.tokenCount.toLocaleString()} tokens</span>}
								</div>
								{session.error !== undefined && (
									<div className="mt-1 break-words text-[10px] text-[var(--danger)] [overflow-wrap:anywhere]">
										{session.error}
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={() => setOpenSessionIdentity(sessionIdentity)}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
							>
								<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
							</button>
						</div>
					</div>
				)}
				{(state.startedAt !== undefined ||
					state.endedAt !== undefined ||
					state.mapItemLabel ||
					state.visits !== undefined) && (
					<dl className="grid grid-cols-2 gap-2 text-[11px]">
						{state.startedAt !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">started</dt>
								<dd>{formatHyperchartDateTime(state.startedAt)}</dd>
							</div>
						)}
						{state.endedAt !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">ended</dt>
								<dd>{formatHyperchartDateTime(state.endedAt)}</dd>
							</div>
						)}
						{state.mapItemLabel && (
							<div className="min-w-0">
								<dt className="text-[var(--text-muted)]">map item</dt>
								<dd className="truncate" title={state.mapItemLabel}>
									{state.mapItemLabel}
								</dd>
							</div>
						)}
						{state.visits !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">visits</dt>
								<dd>{state.visits}</dd>
							</div>
						)}
					</dl>
				)}
				<FanoutStatusCard state={state} />
				{state.usage && (
					<div className="text-[11px] text-[var(--text-tertiary)]">
						usage: {formatHyperchartUsage(state.usage) ?? JSON.stringify(state.usage)}
					</div>
				)}
				{state.visitHistory !== undefined && (
					<VisitHistory
						visits={state.visitHistory}
						{...(state.agent === undefined ? {} : { agentName: state.agent })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
					/>
				)}
				{state.type === "map" && state.mapConfig?.visitHistory !== undefined && (
					<MapVisitHistory
						visits={state.mapConfig.visitHistory}
						{...(state.onReenter === undefined ? {} : { onReenter: state.onReenter })}
					/>
				)}
				{state.type === "map" && state.mapConfig?.visitHistory === undefined && <MapResolvedInputList state={state} />}
			</Section>
			{openSessionIdentity === sessionIdentity && session !== undefined && (
				<AgentSessionDialog
					key={`session-dialog:${sessionIdentity}`}
					agentName={state.agent ?? state.id}
					session={session}
					onClose={() => setOpenSessionIdentity(undefined)}
					{...(onSteerSession === undefined
						? {}
						: { onSteer: (message: string) => onSteerSession(session.actionKey, message) })}
				/>
			)}
		</>
	);
}
