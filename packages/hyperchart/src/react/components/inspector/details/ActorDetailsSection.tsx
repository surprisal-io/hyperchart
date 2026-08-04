import { ArrowsRightLeftIcon, InboxStackIcon, QueueListIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { Section } from "../ui/Section.js";
import { TypeBlock } from "../ui/TypeBlock.js";
import { ActorMailboxCard } from "./ActorMailboxCard.js";
import { ActorProtocolCard } from "./ActorProtocolCard.js";

export function ActorMailboxSection({ state }: { state: HyperchartStateInfo }) {
	const occurrence = state.actorOccurrence;
	if (occurrence === undefined) return null;
	const hasHistory = occurrence.mailboxInstances.length > 1 || occurrence.mailboxInstances.some((instance) => instance.messageHistory.length > 0);
	if (occurrence.currentMessage === undefined && occurrence.mailbox.totalCount === 0 && !hasHistory) return null;
	return (
		<Section
			title={`Mailbox · ${occurrence.currentMessage === undefined ? "" : "1 current · "}${occurrence.mailbox.totalCount} queued`}
			icon={InboxStackIcon}
			defaultOpen={false}
		>
			<ActorMailboxCard instances={occurrence.mailboxInstances} hideHeader />
		</Section>
	);
}

export function ActorDetailsSection({ state }: { state: HyperchartStateInfo }) {
	const declaration = state.actorDeclaration;
	const internal = state.actorInternal;
	if (declaration === undefined && internal === undefined) return null;
	return (
		<>
			<Section title="Actor definition / input" icon={QueueListIcon} defaultOpen>
				<dl className="grid grid-cols-2 gap-2 text-[10px]">
					<div>
						<dt className="text-[var(--text-muted)]">actor path</dt>
						<dd className="break-all font-mono">{declaration?.declarationPath ?? internal?.declarationPath}</dd>
					</div>
					{declaration !== undefined && (
						<div><dt className="text-[var(--text-muted)]">owner</dt><dd className="break-all font-mono">{declaration.ownerPath ?? "chart root"}</dd></div>
					)}
					{internal !== undefined && <div><dt className="text-[var(--text-muted)]">internal state</dt><dd className="font-mono">{internal.localState}</dd></div>}
				</dl>
				{declaration !== undefined && (
					<div>
						<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">immutable input</div>
						<TypeBlock schema={declaration.inputSchema} name="ActorInput" />
					</div>
				)}
			</Section>

			{declaration !== undefined && (
				<Section title={`Protocol · ${declaration.protocol.length} ${declaration.protocol.length === 1 ? "message" : "messages"}`} icon={ArrowsRightLeftIcon} defaultOpen>
					<div className="grid gap-2">{declaration.protocol.map((contract) => <ActorProtocolCard key={contract.event} contract={contract} />)}</div>
				</Section>
			)}

		</>
	);
}
