import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import type { HyperchartActorMailboxInstanceInfo, HyperchartActorMessageInfo } from "../../../types.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";

export function ActorMailboxMessageRow({ message, index, current = false }: { message: HyperchartActorMessageInfo; index?: number; current?: boolean }) {
	const [open, setOpen] = useState(false);
	const toggle = () => setOpen((value) => !value);
	return (
		<div
			className={`cursor-pointer rounded border p-2 text-[10px] ${current ? "border-violet-500/45 bg-violet-500/10 ring-1 ring-violet-500/15" : "border-[var(--border-secondary)] bg-[var(--bg-secondary)]"}`}
			role="button"
			tabIndex={0}
			aria-expanded={open}
			onClick={toggle}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			}}
		>
			<div className="flex min-w-0 items-center gap-2">
				<ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
				<span className={`shrink-0 font-mono ${current ? "text-[var(--hc-purple-text)]" : "w-4 text-[var(--text-muted)]"}`}>{current ? "current" : (index ?? 0) + 1}</span>
				<code className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{message.event}</code>
				<span className={`shrink-0 rounded border px-1 py-0.5 uppercase ${message.callId === undefined ? "border-cyan-500/30 text-[var(--hc-cyan-text)]" : "border-violet-500/30 text-[var(--hc-purple-text)]"}`}>{message.callId === undefined ? "send" : "call"}</span>
				<span className="shrink-0 rounded border border-[var(--border-secondary)] px-1 py-0.5 uppercase">{message.status}</span>
			</div>
			{open && (
				<div className="mt-2 min-w-0 space-y-2 pl-5">
					<dl className="grid min-w-0 gap-1 text-[var(--text-tertiary)] sm:grid-cols-2">
						<div className="min-w-0"><dt className="text-[var(--text-muted)]">message</dt><dd className="truncate font-mono" title={message.messageId}>{message.messageId}</dd></div>
						<div className="min-w-0"><dt className="text-[var(--text-muted)]">producer</dt><dd className="truncate font-mono" title={message.producerVisit}>{message.producerVisit}</dd></div>
						{message.receiveState !== undefined && <div className="min-w-0"><dt className="text-[var(--text-muted)]">receive</dt><dd className="truncate font-mono" title={message.receiveState}>{message.receiveState}</dd></div>}
						{message.replyEvent !== undefined && <div className="min-w-0"><dt className="text-[var(--text-muted)]">reply</dt><dd className="truncate font-mono">{message.replyEvent}</dd></div>}
						{message.validation !== undefined && <div><dt className="text-[var(--text-muted)]">validation</dt><dd>{message.validation}</dd></div>}
					</dl>
					<ExpandablePre collapsedLines={5} language="json">{JSON.stringify(message.input, null, 2)}</ExpandablePre>
				</div>
			)}
		</div>
	);
}

export function ActorMailboxCard({
	instances,
	hideHeader = false,
}: {
	instances: HyperchartActorMailboxInstanceInfo[];
	hideHeader?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const latest = instances.at(-1);
	if (latest === undefined) return null;
	const entries = expanded ? latest.mailbox.entries : latest.mailbox.entries.slice(0, 4);
	const previousInstances = instances.slice(0, -1);
	const hasHistory = previousInstances.length > 0 || latest.messageHistory.length > 0;
	return (
		<div className="rounded-lg border border-[var(--border-secondary)] p-2">
			<div className="mb-2 flex min-w-0 items-center gap-2 text-[10px]">
				<span className="font-semibold text-[var(--text-primary)]">Latest instance · generation {latest.generation}</span>
				<span className="ml-auto shrink-0 uppercase text-[var(--text-muted)]">{latest.status}</span>
			</div>
			{(!hideHeader || latest.mailbox.entries.length > 4) && (
				<div className="flex items-center justify-between gap-2">
					{!hideHeader && <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">FIFO mailbox · {latest.mailbox.totalCount} queued</div>}
					{latest.mailbox.entries.length > 4 && <button type="button" className="ml-auto text-[10px] text-[var(--hc-cyan-text)]" onClick={() => setExpanded((value) => !value)}>{expanded ? "Compact" : `Show all ${latest.mailbox.entries.length}`}</button>}
				</div>
			)}
			<div className="grid gap-1">
				{latest.currentMessage !== undefined && <ActorMailboxMessageRow message={latest.currentMessage} current />}
				{entries.map((entry, index) => <ActorMailboxMessageRow key={entry.messageId} message={entry} index={index} />)}
				{latest.currentMessage === undefined && entries.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">Mailbox is empty.</div>}
				{hasHistory && (
					<button
						type="button"
						className="mt-1 justify-self-start text-[10px] text-[var(--hc-cyan-text)]"
						onClick={() => setShowHistory((value) => !value)}
					>
						{showHistory ? "Hide history" : "Show history"}
					</button>
				)}
				{showHistory && (
					<div className="mt-1 grid gap-2 border-t border-[var(--border-secondary)] pt-2">
						{latest.messageHistory.length > 0 && (
							<section>
								<div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Processed in latest instance · {latest.messageHistory.length}</div>
								<div className="grid gap-1">
									{latest.messageHistory.map((entry, index) => <ActorMailboxMessageRow key={`history:${latest.occurrencePath}:${entry.messageId}`} message={entry} index={index} />)}
								</div>
							</section>
						)}
						{[...previousInstances].reverse().map((instance, instanceIndex) => (
							<section
								key={instance.occurrencePath}
								className={latest.messageHistory.length === 0 && instanceIndex === 0 ? "" : "border-t border-[var(--border-secondary)] pt-2"}
							>
								<div className="mb-1.5 flex min-w-0 items-center gap-2 text-[10px]">
									<span className="font-semibold text-[var(--text-primary)]">Instance · generation {instance.generation}</span>
									<span className="ml-auto shrink-0 uppercase text-[var(--text-muted)]">{instance.status}</span>
								</div>
								<div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Processed messages · {instance.messageHistory.length}</div>
								<div className="grid gap-1">
									{instance.messageHistory.map((entry, index) => <ActorMailboxMessageRow key={`history:${instance.occurrencePath}:${entry.messageId}`} message={entry} index={index} />)}
									{instance.messageHistory.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">No processed messages.</div>}
								</div>
							</section>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
