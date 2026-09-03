import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HistoryCursor } from "../../../../runtime/generic/log_store.js";
import { useHistoryWindow, type HistoryWindowSource } from "./useHistoryWindow.js";

export const HISTORY_VIRTUAL_OVERSCAN = 20;
export const HISTORY_PREFETCH_ITEMS = 40;

export function VirtualizedHistoryList<T>({
	cacheKey,
	source,
	identity,
	renderItem,
	estimateSize = 92,
	initialCursor,
	emptyLabel = "No history.",
	className = "h-96",
}: {
	cacheKey: string;
	source: HistoryWindowSource<T>;
	identity: (item: T) => string;
	renderItem: (item: T, index: number) => React.ReactNode;
	estimateSize?: number;
	initialCursor?: HistoryCursor;
	emptyLabel?: string;
	className?: string;
}) {
	const parentRef = useRef<HTMLDivElement>(null);
	const history = useHistoryWindow({ cacheKey, source, identity, ...(initialCursor === undefined ? {} : { initialCursor }) });
	const items = history.window.items;
	const keys = useMemo(() => items.map(identity), [identity, items]);
	const rowVirtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => estimateSize,
		overscan: HISTORY_VIRTUAL_OVERSCAN,
		initialRect: { width: 0, height: 384 },
		getItemKey: (index) => keys[index] ?? index,
		measureElement: (element) => element.getBoundingClientRect().height,
		anchorTo: "end",
		useAnimationFrameWithResizeObserver: true,
	});
	const virtualItems = rowVirtualizer.getVirtualItems();

	const firstIndex = virtualItems[0]?.index;
	const lastIndex = virtualItems.at(-1)?.index;
	useEffect(() => {
		if (history.window.newer !== undefined && !history.newer.loading && history.newer.error === undefined && firstIndex !== undefined && firstIndex <= HISTORY_PREFETCH_ITEMS) void history.loadNewer();
	}, [firstIndex, history.loadNewer, history.newer.error, history.newer.loading, history.window.newer]);
	useEffect(() => {
		if (history.window.older !== undefined && !history.older.loading && history.older.error === undefined && lastIndex !== undefined && lastIndex >= items.length - HISTORY_PREFETCH_ITEMS) void history.loadOlder();
	}, [history.loadOlder, history.older.error, history.older.loading, history.window.older, items.length, lastIndex]);

	const prefetchAtScrollEdge = () => {
		const element = parentRef.current;
		if (element === null) return;
		const threshold = Math.max(element.clientHeight * 3, estimateSize * HISTORY_PREFETCH_ITEMS);
		if (element.scrollTop <= threshold && history.window.newer !== undefined && !history.newer.loading && history.newer.error === undefined) void history.loadNewer();
		if (element.scrollHeight - element.scrollTop - element.clientHeight <= threshold && history.window.older !== undefined && !history.older.loading && history.older.error === undefined) void history.loadOlder();
	};

	if (history.initial.loading && items.length === 0) return <div className="text-[10px] text-[var(--text-muted)]">Loading history…</div>;
	if (history.initial.error !== undefined && items.length === 0) {
		return <HistoryError edge="history" error={history.initial.error} onRetry={history.retryInitial} />;
	}
	if (items.length === 0) return <div className="text-[10px] text-[var(--text-muted)]">{emptyLabel}</div>;

	return (
		<div className="grid gap-1.5" data-testid="virtualized-history" data-retained-items={items.length}>
		{history.newer.error !== undefined && <HistoryError edge="newer" error={history.newer.error} onRetry={history.loadNewer} />}
		{history.newer.loading && <div className="text-center text-[10px] text-[var(--text-muted)]">Loading newer…</div>}
		<div ref={parentRef} className={`overflow-auto overscroll-contain ${className}`} onScroll={prefetchAtScrollEdge}>
			<div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
				{virtualItems.map((virtualRow) => {
					const item = items[virtualRow.index];
					if (item === undefined) return null;
					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							data-history-row={identity(item)}
							ref={rowVirtualizer.measureElement}
							className="absolute left-0 top-0 w-full pb-2"
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							{renderItem(item, virtualRow.index)}
						</div>
					);
				})}
			</div>
		</div>
		{history.older.loading && <div className="text-center text-[10px] text-[var(--text-muted)]">Loading older…</div>}
		{history.older.error !== undefined && <HistoryError edge="older" error={history.older.error} onRetry={history.loadOlder} />}
		</div>
	);
}

function HistoryError({ edge, error, onRetry }: { edge: string; error: string; onRetry: () => void | Promise<void> }) {
	return (
		<div className="flex items-center justify-between gap-2 rounded border border-red-500/30 bg-red-500/5 p-2 text-[10px] text-[var(--danger)]">
			<span>{edge} load failed: {error}</span>
			<button type="button" className="text-[var(--hc-cyan-text)]" onClick={() => void onRetry()}>Retry</button>
		</div>
	);
}
