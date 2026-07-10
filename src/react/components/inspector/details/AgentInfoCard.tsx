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
	return (
		<div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-2">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-blue-text)]">
					@{state.agent}
				</span>
				{state.model && (
					<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
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
			<div className="mt-2">
				<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">tools</div>
				<div className="flex flex-wrap gap-1">
					{state.tools === undefined ? (
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
		</div>
	);
}
