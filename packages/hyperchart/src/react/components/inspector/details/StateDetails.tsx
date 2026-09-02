import { useEffect } from "react";
import {
	ArchiveBoxIcon,
	ArrowPathIcon,
	ArrowTopRightOnSquareIcon,
	BellIcon,
	CodeBracketSquareIcon,
	RectangleStackIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { HyperchartInspectorDataSource, HyperchartStateInfo } from "../../../types.js";
import type { HistorySnapshot } from "../../../../runtime/generic/log_store.js";
import { agentStatesForSelection, stateConcurrencyLabel, stateDisplayName, stateKindMeta } from "../helpers/state.js";
import {
	artifactContractElementId,
	inputTypeElementId,
	replyFieldElementId,
	replySectionElementId,
	schemaLabel,
	schemaTypeText,
} from "../helpers/schema.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { MapOverRefBlock } from "../prompt/MapOverRefBlock.js";
import { PromptSection } from "../prompt/PromptSection.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { Section } from "../ui/Section.js";
import { TypeBlock } from "../ui/TypeBlock.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";
import { IssuesSection } from "../validation/IssuesSection.js";
import { ValidationSection } from "../validation/ValidationSection.js";
import { AgentInfoCard } from "./AgentInfoCard.js";
import { ActorDetailsSection, ActorMailboxSection } from "./ActorDetailsSection.js";
import { ActorMessageDefinitionSection } from "./ActorMessageDefinitionSection.js";
import { ContractsSection } from "./ContractsSection.js";
import { DefinitionSection } from "./DefinitionSection.js";
import { EnvTypeDisplay } from "./EnvTypeDisplay.js";
import { RuntimeSection } from "./RuntimeSection.js";
import { TransitionsSection } from "./TransitionsSection.js";

export function StateDetails({
	state,
	allStates,
	definitionSource,
	onOpenScope,
	onNavigateToState,
	canOpenScope,
	highlightedReply = null,
	highlightedArtifact = null,
	revealedReplyStateIds = [],
	revealedArtifactStateIds = [],
	onHighlightReply,
	onHighlightArtifact,
	highlightedInputName = null,
	onHighlightInput,
	highlightedRefValue = null,
	onHighlightRef,
	onSteerSession,
	history,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	definitionSource?: string;
	onOpenScope?: (stateId: string) => void;
	onNavigateToState?: (stateId: string) => void;
	canOpenScope?: boolean;
	highlightedReply?: { stateId: string; path: string } | null;
	highlightedArtifact?: { stateId: string; name: string } | null;
	revealedReplyStateIds?: readonly string[];
	revealedArtifactStateIds?: readonly string[];
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
	highlightedInputName?: string | null;
	onHighlightInput?: (name: string) => void;
	highlightedRefValue?: string | null;
	onHighlightRef?: (value: string) => void;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	history?: { runId: string; snapshot: HistorySnapshot; dataSource: HyperchartInspectorDataSource; targetSeqId?: number };
}) {
	const kind = stateKindMeta(state);
	const DetailKindIcon = kind.Icon;
	const concurrencyLabel = stateConcurrencyLabel(state);
	const agentStates = agentStatesForSelection(state, allStates);
	const finalDrainActors = state.type === "final" && (state.status === "waiting" || state.status === "running")
		? allStates.filter((candidate) => candidate.actorOccurrence?.status === "closing" || candidate.actorOccurrence?.status === "draining")
		: [];
	useEffect(() => {
		if (!highlightedReply) return;
		let outerFrame = 0;
		let innerFrame = 0;
		outerFrame = requestAnimationFrame(() => {
			innerFrame = requestAnimationFrame(() => {
				const target =
					document.getElementById(replyFieldElementId(highlightedReply.stateId, highlightedReply.path)) ??
					document.getElementById(replySectionElementId(highlightedReply.stateId));
				target?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
		});
		return () => {
			cancelAnimationFrame(outerFrame);
			cancelAnimationFrame(innerFrame);
		};
	}, [highlightedReply]);
	useEffect(() => {
		if (!highlightedArtifact) return;
		let outerFrame = 0;
		let innerFrame = 0;
		outerFrame = requestAnimationFrame(() => {
			innerFrame = requestAnimationFrame(() => {
				document.getElementById(artifactContractElementId(highlightedArtifact.stateId, highlightedArtifact.name))?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
		});
		return () => {
			cancelAnimationFrame(outerFrame);
			cancelAnimationFrame(innerFrame);
		};
	}, [highlightedArtifact]);
	useEffect(() => {
		if (!highlightedInputName) return;
		let outerFrame = 0;
		let innerFrame = 0;
		outerFrame = requestAnimationFrame(() => {
			innerFrame = requestAnimationFrame(() => {
				document
					.getElementById(inputTypeElementId(state.id, highlightedInputName))
					?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
		});
		return () => {
			cancelAnimationFrame(outerFrame);
			cancelAnimationFrame(innerFrame);
		};
	}, [state.id, highlightedInputName]);
	const focusReplyField = (path: string) => {
		onHighlightReply?.(state.id, path);
	};
	const isScriptState = state.type === "script";
	const isMapState = state.type === "map";
	const mapOver = isMapState ? state.mapConfig?.over : undefined;
	const mapOverSchema = isMapState ? state.mapConfig?.overSchema : undefined;
	return (
		<div className="space-y-3">
			<div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate font-mono text-sm text-[var(--text-primary)]" title={state.id}>
							{stateDisplayName(state)}
						</div>
						{stateDisplayName(state) !== state.id && (
							<div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={state.id}>
								{state.id}
							</div>
						)}
						<div className="mt-1 flex flex-wrap items-center gap-1.5">
							<StatusPill status={state.status} />
							{state.initial === true && (
								<span
									className="inline-flex rounded border border-violet-500/35 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--hc-purple-text)]"
									title="Initial state"
								>
									initial
								</span>
							)}
							{state.agent ? (
								<span
									className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${kind.className}`}
								>
									<DetailKindIcon className="h-3 w-3" aria-hidden="true" /> @{state.agent}
								</span>
							) : (
								<span
									className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${kind.className}`}
								>
									<DetailKindIcon className="h-3 w-3" aria-hidden="true" /> {kind.label}
								</span>
							)}
							{concurrencyLabel && (
								<span className="inline-flex items-center gap-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
									{concurrencyLabel}
								</span>
							)}
						</div>
					</div>
					{canOpenScope && onOpenScope && (
						<div className="flex shrink-0 items-center gap-1">
							<button
								type="button"
								onClick={() => onOpenScope(state.id)}
								className="inline-flex items-center gap-1 rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
							>
								<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" />{" "}
								{state.type === "map" ? "Open map" : "Open scope"}
							</button>
						</div>
					)}
				</div>
			</div>

			{state.type === "final" && state.finalConfig !== undefined && (
				<Section title="Final outcome" icon={BellIcon} defaultOpen>
					<div className="flex flex-wrap items-center gap-2 text-[10px]">
						<span className="text-[var(--text-muted)]">outcome</span>
						<span className={`rounded border px-1.5 py-0.5 font-semibold uppercase ${state.finalConfig.outcome === "failed" ? "border-red-500/35 bg-red-500/10 text-[var(--danger)]" : "border-emerald-500/35 bg-emerald-500/10 text-[var(--hc-green-text)]"}`}>
							{state.finalConfig.outcome}
						</span>
						{state.finalConfig.notify?.scope !== undefined && (
							<span className="font-mono text-[var(--text-muted)]">scope {state.finalConfig.notify.scope}</span>
						)}
					</div>
					{state.finalConfig.notify?.prompt !== undefined && (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">notification prompt</div>
							<TemplateTextBlock
								text={state.finalConfig.notify.prompt}
								state={state}
								allStates={allStates}
								cssCollapse
								wrapLongLines
								{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
								{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
								{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
							/>
						</div>
					)}
					{state.finalConfig.notify?.artifacts?.length ? (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">notification artifacts</div>
							<div className="grid gap-1.5">
								{state.finalConfig.notify.artifacts.map((artifact) => {
									const joined = artifact.readKind === "join";
									const ArtifactIcon = joined ? RectangleStackIcon : ArchiveBoxIcon;
									const typeName = artifact.name.split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Artifact";
									const type = `type ${typeName} = ${schemaTypeText(artifact.schema)};`;
									const content = (
										<>
											<span className="flex w-max items-center gap-1 whitespace-nowrap font-mono text-[10px] text-[var(--hc-purple-text)]">
												<TypeTooltip text={joined ? "joined artifacts" : "artifact"}><span data-hyperchart-tooltip-isolated className="inline-flex"><ArtifactIcon className="h-3 w-3" aria-hidden="true" /></span></TypeTooltip>
												{artifact.sourceState ?? "artifact"} → {artifact.name}
											</span>
											{artifact.path !== undefined && <span className="w-max font-mono text-[9px] text-[var(--text-muted)]">{artifact.path}</span>}
										</>
									);
									const card = artifact.sourceState !== undefined && onHighlightArtifact !== undefined
										? <button type="button" onClick={() => onHighlightArtifact(artifact.sourceState!, artifact.name)} className="flex min-w-0 flex-col items-start overflow-x-auto rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5 text-left hover:bg-purple-500/10">{content}</button>
										: <div className="flex min-w-0 flex-col items-start overflow-x-auto rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5">{content}</div>;
									return <TypeTooltip key={`${artifact.sourceState ?? ""}:${artifact.name}`} text={type}>{card}</TypeTooltip>;
								})}
							</div>
						</div>
					) : null}
					{state.finalConfig.notify === undefined && <div className="text-[10px] text-[var(--text-muted)]">No terminal notification configured.</div>}
				</Section>
			)}

			{finalDrainActors.length > 0 && (
				<Section title={`Waiting for actors · ${finalDrainActors.length}`} icon={ArrowPathIcon} defaultOpen>
					<div className="grid gap-1.5">
						{finalDrainActors.map((actorState) => {
							const actor = actorState.actorOccurrence!;
							const content = (
								<>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-mono text-[var(--text-primary)]">{actor.logicalPath ?? actor.occurrencePath}</span>
										<span className="block truncate text-[9px] text-[var(--text-muted)]">{actor.currentState} · {actor.currentMessage === undefined ? 0 : 1} current · {actor.mailbox.totalCount} queued</span>
									</span>
									{onNavigateToState !== undefined && <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
								</>
							);
							return onNavigateToState === undefined
								? <div key={actorState.id} className="flex items-center rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[10px] text-[var(--text-secondary)]">{content}</div>
								: <button key={actorState.id} type="button" onClick={() => onNavigateToState(actorState.id)} className="flex items-center gap-2 rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-left text-[10px] text-[var(--hc-amber-text)] hover:bg-amber-500/10">{content}</button>;
						})}
					</div>
				</Section>
			)}

			{agentStates.length > 0 && state.type !== "actor-declaration" && state.type !== "actor-occurrence" && (
				<Section title={state.agent ? "Agent" : "Agents in scope"} icon={UserCircleIcon}>
					<div className="space-y-2">
						{agentStates.map((agentState) => (
							<AgentInfoCard
								key={agentState.id}
								state={agentState}
								allStates={allStates}
								{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
								{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
								{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
								{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
							/>
						))}
					</div>
				</Section>
			)}

			<PromptSection
				state={state}
				allStates={allStates}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>

			{(mapOver !== undefined || state.inputs?.length || state.onReenter) && (
				<Section title="Inputs & re-entry" icon={CodeBracketSquareIcon}>
					{mapOver !== undefined && (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-cyan-text)]">map over</div>
							<MapOverRefBlock
								text={mapOver}
								schema={mapOverSchema}
								state={state}
								allStates={allStates}
								{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
								{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
								{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
							/>
						</div>
					)}
					{state.inputs?.length ? (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-green-text)]">
								declared inputs
							</div>
							<div className="grid gap-1">
								{state.inputs.map((input) => (
									<div
										key={input.name}
										className="min-w-0 overflow-hidden rounded border border-emerald-500/20 bg-emerald-500/10 p-2"
									>
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-green-text)]">
												{input.name}
											</span>
											<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
												{input.required ? "required" : "default"}
											</span>
											{input.schema && (
												<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
													{schemaLabel(input.schema)}
												</span>
											)}
										</div>
										{input.preview && (
											<div className="mt-1 break-all font-mono text-[10px] text-[var(--text-secondary)]">
												default: {input.preview}
											</div>
										)}
										{input.schema && (
											<div
												id={inputTypeElementId(state.id, input.name)}
												className={`mt-2 rounded ${highlightedInputName === input.name ? "bg-amber-500/15 ring-1 ring-amber-500/35" : ""}`}
											>
												<TypeBlock schema={input.schema} name={`${input.name} input`} />
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					) : null}
					{state.onReenter && (
						<div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-[11px] text-[var(--text-secondary)]">
							<div className="mb-1 inline-flex items-center gap-1 font-semibold text-[var(--hc-amber-text)]">
								<ArrowPathIcon className="h-3 w-3" aria-hidden="true" /> on re-enter: {state.onReenter.mode}
							</div>
							{state.onReenter.messagePreview && (
								<TemplateTextBlock
									text={state.onReenter.messagePreview}
									state={state}
									allStates={allStates}
									collapsedLines={6}
									{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
									{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
									{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
								/>
							)}
						</div>
					)}
				</Section>
			)}

			<ActorMessageDefinitionSection
				state={state}
				allStates={allStates}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
				{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
			/>

			{state.actorInternal === undefined && <ActorDetailsSection state={state} {...(onNavigateToState === undefined ? {} : { onNavigateToState })} />}

			{state.actorDeclaration !== undefined && state.actorInternal === undefined && (
				<>
					<RuntimeSection
						state={state}
						allStates={allStates}
						{...(history === undefined ? {} : { history })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
						{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
						{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
					/>
					<ActorMailboxSection state={state} />
				</>
			)}

			<TransitionsSection state={state} allStates={allStates} onReplyFieldClick={focusReplyField} />

			<ValidationSection state={state} />

			<IssuesSection issues={state.issues} />

			{(state.actorDeclaration === undefined || state.actorInternal !== undefined) && (
				<RuntimeSection
					state={state}
					allStates={allStates}
					{...(history === undefined ? {} : { history })}
					{...(onSteerSession === undefined ? {} : { onSteerSession })}
					{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
					{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
				/>
			)}

			{isScriptState && (
				<Section title="Arguments" icon={CodeBracketSquareIcon} defaultOpen={false}>
					{state.commandPreview && (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">command</div>
							<TemplateTextBlock
								text={state.commandPreview}
								state={state}
								allStates={allStates}
								collapsedLines={7}
								nowrap
								language="bash"
								{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
								{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
								{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
							/>
						</div>
					)}
					{state.env?.length ? (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">env</div>
							<div className="grid gap-1">
								{state.env.map((env) => (
									<div
										key={env.name}
										className="min-w-0 space-y-2 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[11px]"
									>
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-primary)]">
												{env.name}
											</span>
										</div>
										<EnvTypeDisplay env={env} />
										{env.value !== undefined && (
											<div>
												<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">value</div>
												<TemplateTextBlock
													text={env.value}
													state={state}
													allStates={allStates}
													compact
													nowrap
													{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
													{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
													{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
												/>
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					) : null}
					{!state.commandPreview && !state.env?.length && (
						<div className="text-[var(--text-muted)]">No script arguments.</div>
					)}
				</Section>
			)}

			{state.type !== "actor-declaration" && state.type !== "actor-occurrence" && (
				<ContractsSection
					state={state}
					allStates={allStates}
					highlightedReply={highlightedReply}
					highlightedArtifact={highlightedArtifact}
					revealedReplyStateIds={revealedReplyStateIds}
					revealedArtifactStateIds={revealedArtifactStateIds}
					{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
					{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
					{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
				/>
			)}


			{definitionSource && <DefinitionSection source={definitionSource} />}
		</div>
	);
}
