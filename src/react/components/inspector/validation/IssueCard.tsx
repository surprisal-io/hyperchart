import type { HyperchartIssueInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { issueKindLabel, issueSeverityClasses } from "../helpers/issues.js";
import { JsonBlock } from "../ui/JsonBlock.js";

export function IssueCard({ issue }: { issue: HyperchartIssueInfo }) {
	const classes = issueSeverityClasses(issue.severity);
	return (
		<div className={`rounded-lg border p-2 text-[11px] ${classes.card}`}>
			<div className="flex flex-wrap items-center gap-1.5">
				<span
					className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${classes.badge}`}
				>
					{issue.severity}
				</span>
				<span className="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
					{issueKindLabel(issue.kind)}
				</span>
				<span className="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
					{issue.source}
				</span>
			</div>
			<div className="mt-2 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{issue.message}</div>
			{(issue.stateId !== undefined || issue.seqId !== undefined || issue.timestamp !== undefined) && (
				<dl className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-[var(--text-tertiary)]">
					{issue.stateId !== undefined && (
						<div>
							<dt>state</dt>
							<dd className="break-all font-mono text-[var(--text-secondary)]">{issue.stateId}</dd>
						</div>
					)}
					{issue.seqId !== undefined && (
						<div>
							<dt>seqId</dt>
							<dd className="font-mono text-[var(--text-secondary)]">{issue.seqId}</dd>
						</div>
					)}
					{issue.timestamp !== undefined && (
						<div className="col-span-2">
							<dt>time</dt>
							<dd className="text-[var(--text-secondary)]">{formatHyperchartDateTime(issue.timestamp)}</dd>
						</div>
					)}
				</dl>
			)}
			{issue.payload !== undefined && (
				<details className="mt-2">
					<summary className="cursor-pointer text-[10px] font-semibold text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
						payload
					</summary>
					<div className="mt-1">
						<JsonBlock value={issue.payload} previewLines={10} />
					</div>
				</details>
			)}
		</div>
	);
}
