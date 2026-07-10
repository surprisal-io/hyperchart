import type { HyperchartStateInfo } from "../../../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { replySectionElementId, schemaLabel } from "../helpers/schema.js";
import { stateDisplayName } from "../helpers/state.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { TypeBlock } from "../ui/TypeBlock.js";

export function ContractCard({
	state,
	allStates,
	showStateName,
	highlightedReplyPath,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	showStateName: boolean;
	highlightedReplyPath?: string | null;
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
}) {
	const hasArtifacts = (state.artifacts?.length ?? 0) > 0;
	return (
		<div className="space-y-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2">
			{showStateName && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span
						className="rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
						title={state.id}
					>
						{stateDisplayName(state)}
					</span>
					{state.agent && (
						<span className="rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-blue-text)]">
							@{state.agent}
						</span>
					)}
				</div>
			)}
			{hasArtifacts && (
				<div className="space-y-2">
					<div className="text-[10px] uppercase tracking-wide text-[var(--hc-purple-text)]">artifacts</div>
					{state.artifacts?.map((artifact) => (
						<div key={artifact.name} className="rounded-lg border border-purple-500/20 bg-purple-500/10 p-2">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-purple-text)]">
									{artifact.name}
								</span>
								{artifact.schema && (
									<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
										{schemaLabel(artifact.schema)}
									</span>
								)}
							</div>
							{artifact.path &&
								(hasInterpolation(artifact.path) ? (
									<div className="mt-1">
										<TemplateTextBlock
											text={artifact.path}
											state={state}
											allStates={allStates}
											{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
											{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
											{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
										/>
									</div>
								) : (
									<div className="mt-1 break-all font-mono text-[10px] text-[var(--text-secondary)]">
										{artifact.path}
									</div>
								))}
							{artifact.schema && (
								<div className="mt-2">
									<TypeBlock schema={artifact.schema} name={artifact.name} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{state.replySchema && (
				<div id={replySectionElementId(state.id)}>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-green-text)]">
						reply / result shape
					</div>
					<TypeBlock
						schema={state.replySchema}
						name={`${stateDisplayName(state)} reply`}
						stateId={state.id}
						highlightedPath={highlightedReplyPath ?? null}
					/>
				</div>
			)}
		</div>
	);
}
