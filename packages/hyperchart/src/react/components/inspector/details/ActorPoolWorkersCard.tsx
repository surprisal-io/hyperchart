import { ChevronRightIcon, MapPinIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import type { HyperchartActorMailboxInstanceInfo, HyperchartActorOccurrenceInfo } from "../../../types.js";
import { ActorMailboxCard } from "./ActorMailboxCard.js";

/** Pool worker selector. Selecting a worker shows only its ordinary mailbox view. */
export function ActorPoolWorkersCard({
	occurrence,
}: {
	occurrence: HyperchartActorOccurrenceInfo;
	onNavigateToState?: (stateId: string) => void;
}) {
	const [selectedWorkerIndex, setSelectedWorkerIndex] = useState<number | null>(null);
	if (occurrence.kind !== "actorPool" || occurrence.workers === undefined) return null;
	return (
		<div className="grid min-w-0 gap-1">
			{occurrence.workers.map((worker) => {
				const selected = worker.index === selectedWorkerIndex;
				const mailbox: HyperchartActorMailboxInstanceInfo[] = [{
					occurrencePath: worker.occurrencePath,
					generation: occurrence.generation,
					status: worker.status,
					mailbox: { totalCount: 0, entries: [] },
					messageHistory: worker.messageHistory ?? [],
					...(worker.currentMessage === undefined ? {} : { currentMessage: worker.currentMessage }),
				}];
				return (
					<div key={worker.occurrencePath} className={`min-w-0 overflow-hidden rounded border ${selected ? "border-cyan-500/40 bg-cyan-500/5" : "border-[var(--border-secondary)] bg-[var(--bg-secondary)]"}`}>
						<button
							type="button"
							onClick={() => setSelectedWorkerIndex(selected ? null : worker.index)}
							aria-expanded={selected}
							className="flex w-full min-w-0 items-center gap-2 p-2 text-left text-[10px] hover:bg-cyan-500/5"
						>
							<ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${selected ? "rotate-90" : ""}`} />
							<code className="shrink-0 text-[var(--text-primary)]">$worker-{worker.index}</code>
							<span title="Current state" className="inline-flex min-w-0 items-center gap-1 rounded border border-cyan-500/25 bg-cyan-500/5 px-1.5 py-0.5 text-[var(--hc-cyan-text)]">
								<MapPinIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
								<code className="truncate">{worker.currentState}</code>
							</span>
							<span className="ml-auto shrink-0 uppercase text-[var(--text-muted)]">{worker.status}</span>
						</button>
						{selected && (
							<div className="border-t border-[var(--border-secondary)] bg-[var(--bg-primary)] p-2">
								<ActorMailboxCard instances={mailbox} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
