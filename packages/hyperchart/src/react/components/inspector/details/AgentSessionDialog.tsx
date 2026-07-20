import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDownIcon, CommandLineIcon, PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { HyperchartAgentSessionInfo, HyperchartSessionMessageInfo } from "../../../types.js";
import { DialogPortal } from "../../../support/DialogPortal.js";
import { useModalDialog } from "../../../support/useModalDialog.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";

export function AgentSessionDialog({
	agentName,
	session,
	onClose,
	onSteer,
}: {
	agentName: string;
	session: HyperchartAgentSessionInfo;
	onClose: () => void;
	onSteer?: (message: string) => void | Promise<void>;
}) {
	const titleId = useId();
	const { resolved } = useHyperchartTheme();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const transcriptRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const [message, setMessage] = useState("");
	const [sending, setSending] = useState(false);
	const steeringEnabled = onSteer !== undefined && (session.status === "running" || session.status === "starting");
	const [sendError, setSendError] = useState<string>();
	useModalDialog({ dialogRef, initialFocusRef: closeRef, onClose, open: true });
	useEffect(() => {
		const transcript = transcriptRef.current;
		if (transcript !== null && stickToBottomRef.current) transcript.scrollTop = transcript.scrollHeight;
	}, [session.messages, session.currentReasoning, session.currentText, session.currentTool, session.lastMessage]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const value = message.trim();
		if (value.length === 0 || !steeringEnabled || onSteer === undefined || sending) return;
		setSending(true);
		setSendError(undefined);
		try {
			await onSteer(value);
			setMessage("");
		} catch (error) {
			setSendError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	};

	return (
		<DialogPortal>
			<div data-hyperchart-root data-theme={resolved} className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-6">
				<button
					type="button"
					tabIndex={-1}
					className="absolute inset-0 cursor-default bg-[var(--bg-overlay)]"
					onClick={onClose}
					aria-label="Close agent session"
				/>
				<div
					ref={dialogRef}
					tabIndex={-1}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border-secondary)] bg-[var(--bg-secondary)] shadow-2xl"
				>
					<header className="flex items-center gap-3 border-b border-[var(--border-primary)] px-4 py-3">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/25 bg-blue-500/10 text-[var(--hc-blue-text)]">
							<CommandLineIcon className="h-4 w-4" aria-hidden="true" />
						</div>
						<div className="min-w-0 flex-1">
							<div id={titleId} className="truncate text-sm font-semibold text-[var(--text-primary)]">
								@{agentName} session
							</div>
							<div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
								<span className="inline-flex items-center gap-1">
									<span className={`h-1.5 w-1.5 rounded-full ${session.status === "running" || session.status === "starting" ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`} />
									{session.status}
								</span>
								{session.model && <span>{session.model}</span>}
								{session.turnCount !== undefined && <span>{session.turnCount} turns</span>}
								{session.toolCount !== undefined && <span>{session.toolCount} tools</span>}
								{session.tokenCount !== undefined && <span>{session.tokenCount.toLocaleString()} tokens</span>}
							</div>
						</div>
						<button
							ref={closeRef}
							type="button"
							onClick={onClose}
							className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
							aria-label="Close agent session"
						>
							<XMarkIcon className="h-5 w-5" aria-hidden="true" />
						</button>
					</header>

					<div
						ref={transcriptRef}
						onScroll={(event) => {
							const element = event.currentTarget;
							stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
						}}
						className="max-h-[min(62vh,560px)] space-y-3 overflow-y-auto bg-[var(--bg-primary)] p-4"
					>
						{session.messages?.length ? (
							session.messages
								.filter((entry) => !(entry.role === "tool" && entry.toolStatus === "running" && entry.toolName === session.currentTool))
								.map((entry) => (
								<div key={entry.id} className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}>
									<div className={`max-w-[88%] rounded-xl border px-3 py-2 ${messageClasses(entry.role, entry.isError === true)}`}>
										<div className="mb-1 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wide opacity-70">
											<span>{entry.role === "tool" ? entry.toolName ?? "tool" : entry.role}</span>
											{entry.role === "tool" && entry.toolStatus && (
												<span className={entry.toolStatus === "error" ? "text-[var(--hc-red-text)]" : entry.toolStatus === "completed" ? "text-[var(--hc-green-text)]" : "text-[var(--hc-cyan-text)]"}>
													{entry.toolStatus === "running" ? "loading" : entry.toolStatus === "completed" ? "complete" : "error"}
												</span>
											)}
											{entry.timestamp !== undefined && <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>}
										</div>
										{entry.role === "tool" ? (
											<CollapsibleTranscriptText text={toolLifecycleText(entry)} />
										) : entry.text && entry.role === "reasoning" ? (
											<CollapsibleTranscriptText text={entry.text} />
										) : entry.text ? (
											<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{entry.text}</pre>
										) : null}
									</div>
								</div>
							))
						) : (
							<div className="flex h-full min-h-48 items-center justify-center text-xs text-[var(--text-muted)]">Waiting for session output…</div>
						)}
						{session.currentReasoning && (
							<div className="rounded-xl border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-[var(--text-secondary)]">
								<div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--hc-purple-text)]">
									{session.currentText === undefined && session.currentTool === undefined ? (
										<><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" /> reasoning live</>
									) : (
										<span>reasoning</span>
									)}
								</div>
								{session.currentText === undefined && session.currentTool === undefined ? (
									<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{session.currentReasoning}</pre>
								) : (
									<CollapsibleTranscriptText text={session.currentReasoning} />
								)}
							</div>
						)}
						{session.currentText && (
							<div className="rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 py-2 text-[var(--text-primary)]">
								<div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
									<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> assistant live
								</div>
								<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{session.currentText}</pre>
							</div>
						)}
						{session.currentTool && (
							<div className="rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-[var(--hc-cyan-text)]">
								<div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
									<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" /> {session.currentTool} · loading
								</div>
								{session.currentToolArgs && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--text-secondary)]">{session.currentToolArgs}</pre>}
							</div>
						)}
						{session.error && <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-[var(--hc-red-text)]">{session.error}</div>}
					</div>

					<form onSubmit={(event) => void submit(event)} className="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
						<div className="flex items-end gap-2">
							<textarea
								value={message}
								onChange={(event) => setMessage(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
								}}
								disabled={!steeringEnabled || sending}
								rows={2}
								placeholder={steeringEnabled ? "Steer this agent…" : "Steering is unavailable for this session"}
								aria-label="Steering message"
								className="min-h-12 flex-1 resize-none rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/25 disabled:opacity-60"
							/>
							<button
								type="submit"
								disabled={!steeringEnabled || sending || message.trim().length === 0}
								className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-blue-500/35 bg-blue-500/15 px-3 text-xs font-medium text-[var(--hc-blue-text)] hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-45"
							>
								<PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" /> {sending ? "Sending…" : "Steer"}
							</button>
						</div>
						<div className="mt-1.5 text-[10px] text-[var(--text-muted)]">Ctrl/⌘ + Enter to send after the current tool call.</div>
						{sendError && <div role="alert" className="mt-2 text-[11px] text-[var(--hc-red-text)]">{sendError}</div>}
					</form>
				</div>
			</div>
		</DialogPortal>
	);
}

function toolLifecycleText(entry: HyperchartSessionMessageInfo): string {
	if (entry.toolInput === undefined && entry.toolOutput === undefined) return entry.text ?? "";
	const sections: string[] = [];
	if (entry.toolInput !== undefined) sections.push(`CALL\n${entry.toolInput}`);
	if (entry.toolStatus === "running") sections.push("LOADING…");
	if (entry.toolStatus === "completed") sections.push(`RESULT\n${entry.toolOutput ?? "Completed"}`);
	if (entry.toolStatus === "error") sections.push(`ERROR\n${entry.toolOutput ?? "Tool failed"}`);
	return sections.join("\n\n");
}

function CollapsibleTranscriptText({ text }: { text: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const measurementRef = useRef<HTMLDivElement>(null);
	const [expandable, setExpandable] = useState(false);
	const [expanded, setExpanded] = useState(false);
	useLayoutEffect(() => {
		const container = containerRef.current;
		const measurement = measurementRef.current;
		if (container === null || measurement === null) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(window.getComputedStyle(measurement).lineHeight);
			const nextExpandable = Number.isFinite(lineHeight) && measurement.scrollHeight > lineHeight * 2 + 1;
			setExpandable(nextExpandable);
			if (!nextExpandable) setExpanded(false);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [text]);
	return (
		<div ref={containerRef} className="relative min-w-0">
			<div
				ref={measurementRef}
				aria-hidden="true"
				style={{ contain: "strict" }}
				className="pointer-events-none invisible absolute inset-x-0 h-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
			>
				{text}
			</div>
			{expandable ? (
				<div>
					{expanded ? (
						<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{text}</pre>
					) : (
						<div className="relative">
							<div className="max-h-[2.9em] overflow-hidden whitespace-pre-wrap break-words pr-5 font-mono text-[11px] leading-relaxed">
								{text}
							</div>
							<span className="absolute bottom-0 right-0 px-1 font-mono text-[11px] text-[var(--text-muted)]" aria-hidden="true">…</span>
						</div>
					)}
					<button
						type="button"
						onClick={() => setExpanded((value) => !value)}
						aria-expanded={expanded}
						className="mt-1 inline-flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
					>
						<ChevronDownIcon className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
						{expanded ? "Collapse" : "Expand"}
					</button>
				</div>
			) : (
				<pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{text}</pre>
			)}
		</div>
	);
}

function messageClasses(role: HyperchartSessionMessageInfo["role"], isError: boolean): string {
	if (isError) return "border-red-500/25 bg-red-500/10 text-[var(--hc-red-text)]";
	if (role === "user") return "border-blue-500/25 bg-blue-500/10 text-[var(--text-primary)]";
	if (role === "tool") return "border-cyan-500/20 bg-cyan-500/5 text-[var(--text-secondary)]";
	if (role === "reasoning") return "border-violet-500/20 bg-violet-500/5 text-[var(--text-secondary)]";
	if (role === "system") return "border-amber-500/20 bg-amber-500/5 text-[var(--text-secondary)]";
	return "border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]";
}
