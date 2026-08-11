import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { Section } from "../ui/Section.js";
import { TypeBlock } from "../ui/TypeBlock.js";
import { ActorProtocolCard } from "./ActorProtocolCard.js";

export function ActorMessageDefinitionSection({
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
	const definition = state.actorMessageDefinition;
	if (definition === undefined) return null;
	const title = definition.kind === "receive"
		? "Accepted message contracts"
		: definition.kind === "reply"
			? "Reply definition"
			: "Outgoing message definition";
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
					{definition.to !== undefined && (
						<div>
							<div className="text-[var(--text-muted)]">actor target</div>
							<div className="break-all font-mono text-[var(--text-primary)]">{definition.to}</div>
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
							cssCollapse
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
