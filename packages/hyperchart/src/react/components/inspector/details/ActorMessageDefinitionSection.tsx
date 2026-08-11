import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { Section } from "../ui/Section.js";
import { TypeBlock } from "../ui/TypeBlock.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";
import { ActorProtocolCard } from "./ActorProtocolCard.js";

export function ActorMessageDefinitionSection({
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	onNavigateToState,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onNavigateToState?: (stateId: string) => void;
}) {
	const definition = state.actorMessageDefinition;
	if (definition === undefined) return null;
	const title = definition.kind === "receive"
		? "Accepted message contracts"
		: definition.kind === "reply"
			? "Reply definition"
			: "Outgoing message definition";
	const targetPath = state.actorMessageLink?.to ?? definition.resolvedTo ?? definition.to;
	const targetState = targetPath === undefined
		? undefined
		: allStates.find((candidate) => candidate.id === targetPath)
			?? allStates.find((candidate) => candidate.actorDeclaration?.declarationPath === targetPath);
	const targetStateId = targetState?.id ?? targetPath;
	return (
		<Section title={title} icon={ArrowsRightLeftIcon} defaultOpen>
			<div className="space-y-3">
				<div className="grid grid-cols-2 gap-2 text-[10px]">
					<div>
						<div className="text-[var(--text-muted)]">operation</div>
						<div className="font-mono text-[var(--text-primary)]">{definition.kind}</div>
					</div>
					{definition.event !== undefined && (
						<div>
							<div className="text-[var(--text-muted)]">event</div>
							<div className="font-mono text-[var(--hc-amber-text)]">{definition.event}</div>
						</div>
					)}
					{definition.to !== undefined && targetStateId !== undefined && (
						<div>
							<div className="text-[var(--text-muted)]">actor target</div>
							<TypeTooltip text={`state ${targetStateId}`}>
								<button
									type="button"
									onClick={() => onNavigateToState?.(targetStateId)}
									className={`mt-0.5 break-all rounded border px-1.5 py-0.5 text-left font-mono font-semibold transition-colors hover:underline focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${definition.targetKind === "self" ? "border-violet-400/35 bg-violet-500/15 text-[var(--hc-purple-text)] hover:bg-violet-500/25" : "border-[var(--border-secondary)] bg-[var(--bg-tertiary)] text-[var(--hc-cyan-text)] hover:bg-[var(--bg-hover)]"}`}
									aria-label={`Navigate to actor state ${targetStateId}`}
								>
									{definition.targetKind === "self" ? "Self()" : definition.to}
								</button>
							</TypeTooltip>
						</div>
					)}
					{definition.target !== undefined && (
						<div>
							<div className="text-[var(--text-muted)]">next state</div>
							<div className="break-all font-mono text-[var(--text-primary)]">{definition.target}</div>
						</div>
					)}
				</div>

				{definition.payload !== undefined && (
					<div>
						<div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--hc-cyan-text)]">
							{definition.payload.label} expression
						</div>
						<TemplateTextBlock
							text={definition.payload.source}
							state={state}
							allStates={allStates}
							language="typescript"
							collapsedLines={4}
							wrapLongLines
							{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
							{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
							{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
						/>
						{definition.payload.schema !== undefined && definition.kind === "reply" && (
							<div className="mt-2">
								<TypeBlock schema={definition.payload.schema} name="ReplyOutput" />
							</div>
						)}
					</div>
				)}

				{definition.contracts?.length ? (
					<div>
						<div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
							{definition.contracts.length === 1 ? "message contract" : "message contracts"}
						</div>
						<div className="grid gap-2">
							{definition.contracts.map((contract) => <ActorProtocolCard key={contract.event} contract={contract} />)}
						</div>
					</div>
				) : null}
			</div>
		</Section>
	);
}
