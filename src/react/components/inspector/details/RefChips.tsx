import type { HyperchartStateInfo } from "../../../types.js";
import { refEntries, refValueElementId } from "../helpers/schema.js";

export function RefChips({
	refs,
	stateId,
	highlightedValue = null,
}: {
	refs: HyperchartStateInfo["refs"];
	stateId?: string;
	highlightedValue?: string | null;
}) {
	const entries = refEntries(refs);
	if (entries.length === 0) return null;
	return (
		<div className="grid gap-1">
			{entries.map((entry) => (
				<div
					key={entry.kind}
					className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded bg-[var(--bg-secondary)] px-2 py-1"
				>
					<span className="font-mono text-[10px] text-[var(--text-muted)]">{entry.kind}</span>
					<div className="flex min-w-0 flex-wrap gap-1">
						{entry.values.map((value) => (
							<span
								key={value}
								{...(stateId === undefined ? {} : { id: refValueElementId(stateId, value) })}
								className={`max-w-full break-all rounded px-1.5 py-0.5 font-mono text-[10px] ${highlightedValue === value ? "bg-amber-500/15 text-[var(--hc-amber-text)] ring-1 ring-amber-500/35" : "bg-[var(--bg-code)] text-[var(--text-secondary)]"}`}
							>
								{value}
							</span>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
