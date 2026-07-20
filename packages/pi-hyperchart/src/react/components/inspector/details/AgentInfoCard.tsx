import { useState } from "react";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { schemaLabel } from "../helpers/schema.js";
import { PathChip } from "./PathChip.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";

export function AgentInfoCard({
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	onSteerSession,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
}) {
	const [sessionOpen, setSessionOpen] = useState(false);
	return (
		<div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-2">
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					<span
						className="max-w-full truncate rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-blue-text)]"
						title={`@${state.agent}`}
					>
						@{state.agent}
					</span>
					{state.model && (
						<span className="max-w-full truncate rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]" title={state.model}>
							{state.model}
						</span>
					)}
					{state.thinking && (
						<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
							think {state.thinking}
						</span>
					)}
					{state.artifacts?.length ? (
						<span className="rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-[var(--hc-purple-text)]">
							{state.artifacts.length} artifacts
						</span>
					) : null}
					{state.replySchema && (
						<span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-[var(--hc-green-text)]">
							reply {schemaLabel(state.replySchema)}
						</span>
					)}
				</div>
				{state.session && (
					<button
						type="button"
						onClick={() => setSessionOpen(true)}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
					>
						<span className={`h-1.5 w-1.5 rounded-full ${state.session.status === "running" || state.session.status === "starting" ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`} />
						<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
					</button>
				)}
			</div>
			{state.agentDescription ? (
				<p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{state.agentDescription}</p>
			) : null}
			{state.agentDefinitionUnavailable === true ? (
				<div
					role="alert"
					className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-[var(--hc-amber-text)]"
				>
					Agent definition could not be loaded. Model, thinking, tools, and system prompt are unavailable; this
					 state cannot run.
				</div>
			) : null}
			<div className="mt-2">
				<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">tools</div>
				<div className="flex flex-wrap gap-1">
					{state.agentDefinitionUnavailable === true ? (
						<span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-amber-text)]">
							unavailable
						</span>
					) : state.tools === undefined ? (
						<span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-green-text)]">
							all tools allowed
						</span>
					) : state.tools.length > 0 ? (
						state.tools.map((tool) => (
							<span
								key={tool}
								className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-tertiary)]"
							>
								{tool}
							</span>
						))
					) : (
						<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
							no tools
						</span>
					)}
				</div>
			</div>
			{state.reads?.length ? (
				<div className="mt-2">
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">reads</div>
					<div className="grid min-w-0 gap-1">
						{state.reads.map((id) =>
							hasInterpolation(id) ? (
								<TemplateTextBlock
									key={id}
									text={id}
									state={state}
									allStates={allStates}
									{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
									{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
									{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
								/>
							) : (
								<PathChip key={id} value={id} />
							),
						)}
					</div>
				</div>
			) : null}
			{sessionOpen && state.session && (
				<AgentSessionDialog
					agentName={state.agent ?? state.id}
					session={state.session}
					onClose={() => setSessionOpen(false)}
					{...(onSteerSession === undefined
						? {}
						: { onSteer: (message: string) => onSteerSession(state.session!.actionKey, message) })}
				/>
			)}
		</div>
	);
}
