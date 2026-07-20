import { HyperchartGraphPreview } from "../../HyperchartInspectorDialog.js";
import type { HyperchartRunInfo } from "../../types.js";

export function GraphTile({
	title,
	run,
	height = "h-[360px]",
}: {
	title: string;
	run: HyperchartRunInfo;
	height?: string;
}) {
	return (
		<div className="min-w-0 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)]">
			<div className="flex items-center justify-between gap-3 border-b border-[var(--border-primary)] px-3 py-2">
				<div className="min-w-0">
					<div className="truncate text-xs font-semibold text-[var(--text-primary)]">{title}</div>
					<div className="truncate text-[10px] text-[var(--text-muted)]">
						{run.stateCount} states · {run.status}
					</div>
				</div>
			</div>
			<HyperchartGraphPreview run={run} className={height} />
		</div>
	);
}
