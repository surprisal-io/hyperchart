import type { HyperchartStateInfo } from "../../../types.js";

/** Compact, payload-free actor summary used in the owner graph. */
export function ActorNodePreview({ state }: { state: HyperchartStateInfo }) {
	const actor = state.actorOccurrence;
	const declaration = state.actorDeclaration;
	const mailbox = actor?.mailbox;
	return (
		<div className="mt-2 min-w-0 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[9px]">
			<div className="flex items-center justify-between gap-2 text-[var(--text-secondary)]">
				<span className="truncate font-mono" title={actor?.currentState ?? declaration?.initialReceive}>
					{actor?.kind === "actorPool" ? `pool ${actor.activeCount ?? 0}/${actor.concurrency ?? 0} active` : `receive: ${actor?.currentState ?? declaration?.initialReceive ?? "unknown"}`}
				</span>
				<span className="shrink-0 rounded bg-amber-500/10 px-1 text-[var(--hc-amber-text)]">
					{mailbox?.totalCount ?? 0} queued
				</span>
			</div>
			{actor?.currentMessage !== undefined && (
				<div className="mt-1 flex min-w-0 items-center gap-1 text-[var(--text-tertiary)]">
					<span className="shrink-0">current</span>
					<span className="truncate font-mono" title={actor.currentMessage.messageId}>{actor.currentMessage.event}</span>
					{actor.currentMessage.callId !== undefined && <span className="shrink-0 text-[var(--hc-purple-text)]">call</span>}
				</div>
			)}
		</div>
	);
}
