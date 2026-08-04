import type { HyperchartActorMessageContractInfo } from "../../../types.js";
import { TypeBlock } from "../ui/TypeBlock.js";

export function ActorProtocolCard({ contract }: { contract: HyperchartActorMessageContractInfo }) {
	const namedReplies = Object.entries(contract.reply.schemas ?? {});
	return (
		<article className="overflow-hidden rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)]">
			<header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-secondary)] px-2.5 py-2">
				<code className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-[var(--hc-amber-text)]">{contract.event}</code>
				<span className="text-[10px] text-[var(--text-muted)]">message</span>
				{contract.reply.kind !== "named" && <span aria-hidden="true" className="text-[var(--text-muted)]">→</span>}
				{contract.reply.kind === "void" && <span className="text-[10px] text-[var(--text-muted)]">no reply</span>}
				{contract.reply.kind === "single" && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-purple-text)]">reply</span>}
			</header>
			<div className="grid gap-3 p-2.5">
				<div>
					<div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Message input</div>
					<TypeBlock schema={contract.input} name={`${contract.event}Input`} />
				</div>
				{contract.reply.schema !== undefined && (
					<div>
						<div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Reply</div>
						<TypeBlock schema={contract.reply.schema} name={`${contract.event}Reply`} />
					</div>
				)}
				{namedReplies.length > 0 && (
					<section aria-label="Reply events">
						<div className="mb-1.5 flex items-baseline justify-between gap-2">
							<h4 className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Reply events</h4>
							<span className="text-[9px] tabular-nums text-[var(--text-muted)]">{namedReplies.length}</span>
						</div>
						<div className="grid gap-2">{namedReplies.map(([event, schema]) => <TypeBlock key={event} schema={schema} name={event} />)}</div>
					</section>
				)}
			</div>
		</article>
	);
}
