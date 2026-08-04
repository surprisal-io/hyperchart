import { ArchiveBoxIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { schemaLabel, schemaTypeText } from "../helpers/schema.js";
import { PathChip } from "./PathChip.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

export function AgentInfoCard({
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	onHighlightArtifact,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
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
					<div className="grid min-w-0 gap-1.5">
						{state.readArtifacts?.map((artifact) => {
							const typeName = artifact.name.split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Artifact";
							const type = `type ${typeName} = ${schemaTypeText(artifact.schema)};`;
							const label = `${artifact.sourceState ?? "artifact"} → ${artifact.name}`;
							const joined = artifact.readKind === "join";
							const ReadIcon = joined ? RectangleStackIcon : ArchiveBoxIcon;
							const content = (
								<>
									<span className="flex w-max items-center gap-1 whitespace-nowrap font-mono text-[10px] text-[var(--hc-purple-text)]">
										<TypeTooltip text={joined ? "joined artifacts" : "artifact"}><span data-hyperchart-tooltip-isolated data-artifact-read-kind={joined ? "join" : "single"} className="inline-flex"><ReadIcon className="h-3 w-3 shrink-0" aria-hidden="true" /></span></TypeTooltip>
										<span>{label}</span>
									</span>
									{artifact.path && <span className="w-max whitespace-nowrap font-mono text-[9px] text-[var(--text-muted)]">{artifact.path}</span>}
								</>
							);
							const trigger = artifact.sourceState !== undefined && onHighlightArtifact !== undefined ? (
								<button type="button" onClick={() => onHighlightArtifact(artifact.sourceState!, artifact.name)} className="flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5 text-left hover:bg-purple-500/10">{content}</button>
							) : (
								<div className="flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5">{content}</div>
							);
							return <TypeTooltip key={`${artifact.sourceState ?? ""}:${artifact.name}`} text={type}>{trigger}</TypeTooltip>;
						})}
						{state.reads.filter((read) => !/^(?:artifactOf|joinArtifactOf)\(/.test(read)).map((read) =>
							hasInterpolation(read) ? (
								<TemplateTextBlock key={read} text={read} state={state} allStates={allStates} nowrap compact {...(onHighlightInput === undefined ? {} : { onHighlightInput })} {...(onHighlightReply === undefined ? {} : { onHighlightReply })} {...(onHighlightRef === undefined ? {} : { onHighlightRef })} />
							) : <PathChip key={read} value={read} />,
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}
