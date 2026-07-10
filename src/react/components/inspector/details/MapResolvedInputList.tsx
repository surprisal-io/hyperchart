import type { HyperchartStateInfo } from "../../../types.js";
import { mapItemDotClass } from "../helpers/fanout.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { JsonBlock } from "../ui/JsonBlock.js";

export function MapResolvedInputList({ state }: { state: HyperchartStateInfo }) {
	const items = state.type === "map" ? state.mapConfig?.items : undefined;
	if (items === undefined) return null;
	return (
		<div className="space-y-2">
			<div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Resolved map items</div>
			<div className="text-[11px] text-[var(--text-secondary)]">
				{items.length} item{items.length === 1 ? "" : "s"} resolved from{" "}
				<code className="rounded bg-[var(--bg-code)] px-1 py-0.5 font-mono text-[10px]">over</code>.
			</div>
			{items.length === 0 ? (
				<div className="rounded border border-dashed border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[11px] text-[var(--text-muted)]">
					The map input resolved to an empty object.
				</div>
			) : (
				<div className="grid gap-2">
					{items.map((item) => (
						<div
							key={item.key}
							className="min-w-0 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[11px]"
						>
							<div className="flex min-w-0 flex-wrap items-center gap-1.5">
								{item.status !== undefined && (
									<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mapItemDotClass(item.status)}`} />
								)}
								<code
									className="max-w-32 truncate rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-primary)]"
									title={item.key}
								>
									{item.key}
								</code>
								<span
									className="min-w-0 max-w-full flex-1 truncate font-medium text-[var(--text-primary)]"
									title={item.label}
								>
									{item.label}
								</span>
								{item.status !== undefined && (
									<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
										{item.status}
									</span>
								)}
							</div>
							{item.state !== undefined && (
								<code
									className="mt-1 block max-w-full truncate font-mono text-[10px] text-[var(--text-tertiary)]"
									title={item.state}
								>
									{item.state}
								</code>
							)}
							{item.summary !== undefined && (
								<div className="mt-2">
									<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">summary</div>
									<ExpandablePre collapsedLines={4}>{item.summary}</ExpandablePre>
								</div>
							)}
							{item.value !== undefined && (
								<div className="mt-2">
									<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">value</div>
									<JsonBlock value={item.value} previewLines={7} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
