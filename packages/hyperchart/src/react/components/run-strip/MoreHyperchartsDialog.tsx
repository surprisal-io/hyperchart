import { useId, useRef } from "react";
import { PlayIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { formatHyperchartTime, hyperchartRunLabel } from "../../hyperchart-display.js";
import type { HyperchartRunInfo, HyperchartRunSummaryInfo, HyperchartSummaryInfo } from "../../types.js";
import { DialogPortal } from "../../support/DialogPortal.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { useModalDialog } from "../../support/useModalDialog.js";

export function MoreHyperchartsDialog({
	hypercharts,
	runs,
	selectedRunId,
	onSelectRun,
	onRun,
	onOpenDefinition,
	onClose,
}: {
	hypercharts: HyperchartSummaryInfo[];
	runs: Array<HyperchartRunInfo | HyperchartRunSummaryInfo>;
	selectedRunId?: string;
	onSelectRun: (runId: string) => void;
	onRun?: (chartName: string) => void;
	onOpenDefinition?: (flow: HyperchartSummaryInfo) => void;
	onClose: () => void;
}) {
	const { resolved } = useHyperchartTheme();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose });
	return (
		<DialogPortal>
			<div
				data-hyperchart-root
				data-theme={resolved}
				className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-24"
			>
				<button
					type="button"
					tabIndex={-1}
					className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-sm"
					onClick={onClose}
					aria-label="Close more hypercharts"
				/>
				<div
					ref={dialogRef}
					tabIndex={-1}
					className="relative w-full max-w-3xl rounded-2xl border border-blue-500/30 bg-[var(--bg-primary)] shadow-2xl shadow-black/40 ring-1 ring-black/10"
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
				>
					<div className="flex items-center justify-between gap-3 border-b border-[var(--border-primary)] px-4 py-3">
						<div>
							<div id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
								More hypercharts
							</div>
							<div className="text-[10px] text-[var(--text-muted)]">Older runs and chart launch actions</div>
						</div>
						<button
							ref={closeButtonRef}
							type="button"
							onClick={onClose}
							className="rounded border border-[var(--border-secondary)] p-1 text-[var(--text-muted)] hover:border-blue-500/40 hover:text-[var(--hc-blue-text)]"
							aria-label="Close more hypercharts popup"
						>
							<XMarkIcon className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>

					<div className="space-y-4 p-4">
						{runs.length > 0 && (
							<section>
								<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
									Older runs
								</div>
								<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
									{runs.map((run) => (
										<button
											type="button"
											key={run.runId}
											onClick={() => onSelectRun(run.runId)}
											className={`min-w-0 rounded border px-3 py-2 text-left text-[10px] ${run.runId === selectedRunId ? "border-blue-500/60 bg-blue-500/10 text-[var(--hc-blue-text)]" : "border-[var(--border-secondary)] text-[var(--text-secondary)] hover:border-blue-500/40 hover:bg-[var(--bg-secondary)]"}`}
											title={run.runId}
										>
											<div className="truncate font-mono">{hyperchartRunLabel(run)}</div>
											<div className="mt-1 text-[var(--text-muted)]">{formatHyperchartTime(run.updatedAt)}</div>
										</button>
									))}
								</div>
							</section>
						)}

						{hypercharts.length > 0 && (
							<section>
								<div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
									Start chart
								</div>
								<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
									{hypercharts.map((flow) => (
										<div key={flow.name} className="flex min-w-0 overflow-hidden rounded border border-blue-500/30">
											<button
												type="button"
												onClick={() => {
													onRun?.(flow.name);
													onClose();
												}}
												className="inline-flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-left text-[10px] text-[var(--hc-blue-text)] hover:bg-blue-500/10"
												title={flow.name}
											>
												<PlayIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
												<span className="truncate font-mono">{flow.name}</span>
											</button>
											{flow.scope === "project" && flow.source && onOpenDefinition && (
												<button
													type="button"
													onClick={() => {
														onOpenDefinition(flow);
														onClose();
													}}
													className="border-l border-blue-500/30 px-2 py-2 text-[10px] text-[var(--text-muted)] hover:bg-blue-500/10 hover:text-[var(--hc-blue-text)]"
													title="Open chart source"
												>
													TS
												</button>
											)}
										</div>
									))}
								</div>
							</section>
						)}
					</div>
				</div>
			</div>
		</DialogPortal>
	);
}
