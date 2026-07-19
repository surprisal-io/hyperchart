import { useEffect } from "react";
import {
	ArrowPathIcon,
	ArrowTopRightOnSquareIcon,
	CodeBracketSquareIcon,
	ShareIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { agentStatesForSelection, stateConcurrencyLabel, stateDisplayName, stateKindMeta } from "../helpers/state.js";
import {
	inputTypeElementId,
	refEntries,
	refValueElementId,
	replyFieldElementId,
	replySectionElementId,
	schemaLabel,
} from "../helpers/schema.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { MapOverRefBlock } from "../prompt/MapOverRefBlock.js";
import { PromptSection } from "../prompt/PromptSection.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { Section } from "../ui/Section.js";
import { TypeBlock } from "../ui/TypeBlock.js";
import { IssuesSection } from "../validation/IssuesSection.js";
import { ValidationSection } from "../validation/ValidationSection.js";
import { AgentInfoCard } from "./AgentInfoCard.js";
import { ContractsSection } from "./ContractsSection.js";
import { DefinitionSection } from "./DefinitionSection.js";
import { EnvTypeDisplay } from "./EnvTypeDisplay.js";
import { RuntimeSection } from "./RuntimeSection.js";
import { RefChips } from "./RefChips.js";
import { TransitionsSection } from "./TransitionsSection.js";

export function StateDetails({
	state,
	allStates,
	definitionSource,
	onOpenScope,
	canOpenScope,
	highlightedReply = null,
	revealedReplyStateIds = [],
	onHighlightReply,
	highlightedInputName = null,
	onHighlightInput,
	highlightedRefValue = null,
	onHighlightRef,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	definitionSource?: string;
	onOpenScope?: (stateId: string) => void;
	canOpenScope?: boolean;
	highlightedReply?: { stateId: string; path: string } | null;
	revealedReplyStateIds?: readonly string[];
	onHighlightReply?: (stateId: string, path: string) => void;
	highlightedInputName?: string | null;
	onHighlightInput?: (name: string) => void;
	highlightedRefValue?: string | null;
	onHighlightRef?: (value: string) => void;
}) {
	const kind = stateKindMeta(state);
	const DetailKindIcon = kind.Icon;
	const concurrencyLabel = stateConcurrencyLabel(state);
	const agentStates = agentStatesForSelection(state, allStates);
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
	useEffect(() => {
		if (!highlightedRefValue) return;
		let outerFrame = 0;
		let innerFrame = 0;
		outerFrame = requestAnimationFrame(() => {
			innerFrame = requestAnimationFrame(() => {
				document
					.getElementById(refValueElementId(state.id, highlightedRefValue))
					?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
		});
		return () => {
			cancelAnimationFrame(outerFrame);
			cancelAnimationFrame(innerFrame);
		};
	}, [state.id, highlightedRefValue]);
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

			{agentStates.length > 0 && (
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

			<TransitionsSection state={state} allStates={allStates} onReplyFieldClick={focusReplyField} />

			<ValidationSection state={state} />

			<IssuesSection issues={state.issues} />

			<RuntimeSection state={state} />

			{isScriptState && (
				<Section title="Arguments" icon={CodeBracketSquareIcon} defaultOpen={false}>
					{state.commandPreview && (
						<div>
							<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">command</div>
							<ExpandablePre collapsedLines={7} language="bash">
								{state.commandPreview}
							</ExpandablePre>
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
												<code className="block overflow-x-auto whitespace-pre rounded bg-[var(--bg-code)] px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)]">
													{env.value}
												</code>
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

			<ContractsSection
				state={state}
				allStates={allStates}
				highlightedReply={highlightedReply}
				revealedReplyStateIds={revealedReplyStateIds}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>

			{refEntries(state.refs).length > 0 && (
				<Section title="Refs" icon={ShareIcon} defaultOpen={false} forceOpen={highlightedRefValue !== null}>
					<RefChips refs={state.refs} stateId={state.id} highlightedValue={highlightedRefValue} />
				</Section>
			)}

			{definitionSource && <DefinitionSection source={definitionSource} />}
		</div>
	);
}
