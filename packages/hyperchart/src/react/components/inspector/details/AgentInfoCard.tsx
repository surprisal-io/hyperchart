import type { HyperchartStateInfo } from "../../../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { schemaLabel } from "../helpers/schema.js";
import { PathChip } from "./PathChip.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";

export function AgentInfoCard({
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
}) {
	const effectiveModel = state.resolvedModel ?? state.model;
	const effectiveTools = state.resolvedTools ?? state.tools;
	const modelTitle = state.role === undefined
		? effectiveModel
		: effectiveModel === undefined
			? `Role ${state.role} is not resolved`
			: `Role ${state.role} resolves to ${effectiveModel}`;
	return (
		<div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-2">
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<span
					className="max-w-full truncate rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-blue-text)]"
					title={`@${state.agent}`}
				>
					@{state.agent}
				</span>
				{state.role && (
					<span className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-[var(--hc-purple-text)]">
						role {state.role}
					</span>
				)}
				{effectiveModel !== undefined ? (
					<span className="max-w-full truncate rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]" title={modelTitle}>
						{effectiveModel}
					</span>
				) : state.role !== undefined ? (
					<span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-[var(--hc-amber-text)]">
						model unresolved
					</span>
				) : null}
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
				<div className="mb-1 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
					<span>tools</span>
					{state.toolset !== undefined && (
						<span className="rounded border border-violet-500/25 bg-violet-500/10 px-1 py-0.5 font-mono normal-case tracking-normal text-[var(--hc-purple-text)]">
							toolset {state.toolset}
						</span>
					)}
				</div>
				<div className="flex flex-wrap gap-1">
					{state.agentDefinitionUnavailable === true ? (
						<span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-amber-text)]">
							unavailable
						</span>
					) : effectiveTools === undefined && state.toolset !== undefined ? (
						<span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-amber-text)]">
							toolset unresolved
						</span>
					) : effectiveTools === undefined ? (
						<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
							host default tools
						</span>
					) : effectiveTools.length > 0 ? (
						effectiveTools.map((tool) => (
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
		</div>
	);
}
