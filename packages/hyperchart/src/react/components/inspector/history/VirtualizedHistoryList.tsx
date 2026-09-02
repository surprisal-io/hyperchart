import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HistoryCursor } from "../../../../runtime/generic/log_store.js";
import { useHistoryWindow, type HistoryWindowSource } from "./useHistoryWindow.js";

export const HISTORY_VIRTUAL_OVERSCAN = 20;

export type HistoryScrollAnchor = Readonly<{ key: string; pixelOffset: number }>;

/** Captures durable row identity and its pixel offset from the viewport's scroll origin. */
export function captureHistoryScrollAnchor(keys: readonly string[], rows: readonly { index: number; start: number }[], scrollTop: number): HistoryScrollAnchor | undefined {
	const first = rows[0];
	if (first === undefined) return undefined;
	const key = keys[first.index];
	return key === undefined ? undefined : { key, pixelOffset: scrollTop - first.start };
}

/** Resolves the exact scroll position needed to preserve a captured durable-row anchor. */
export function restoreHistoryScrollTop(anchor: HistoryScrollAnchor, keys: readonly string[], rowStart: (index: number) => number | undefined): number | undefined {
	const index = keys.indexOf(anchor.key);
	if (index < 0) return undefined;
	const start = rowStart(index);
	return start === undefined ? undefined : start + anchor.pixelOffset;
}

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
	const anchorRef = useRef<HistoryScrollAnchor | undefined>(undefined);
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
	});
	const virtualItems = rowVirtualizer.getVirtualItems();

	useLayoutEffect(() => {
		anchorRef.current = undefined;
		if (parentRef.current !== null) parentRef.current.scrollTop = 0;
	}, [cacheKey, initialCursor]);

	const rememberAnchor = () => {
		const element = parentRef.current;
		if (element === null) return;
		anchorRef.current = captureHistoryScrollAnchor(keys, rowVirtualizer.getVirtualItems(), element.scrollTop);
	};
	const loadOlder = () => {
		rememberAnchor();
		return history.loadOlder();
	};
	const loadNewer = () => {
		rememberAnchor();
		return history.loadNewer();
	};

	useLayoutEffect(() => {
		const anchor = anchorRef.current;
		const element = parentRef.current;
		if (anchor === undefined || element === null) return;
		rowVirtualizer.measure();
		const scrollTop = restoreHistoryScrollTop(anchor, keys, (index) => rowVirtualizer.getOffsetForIndex(index, "start")?.[0]);
		anchorRef.current = undefined;
		if (scrollTop !== undefined) element.scrollTop = scrollTop;
	}, [keys, rowVirtualizer]);

	const firstIndex = virtualItems[0]?.index;
	const lastIndex = virtualItems.at(-1)?.index;
	useEffect(() => {
		if (history.window.newer !== undefined && !history.newer.loading && history.newer.error === undefined && firstIndex !== undefined && firstIndex <= 5) void loadNewer();
	}, [firstIndex, history.newer.error, history.newer.loading, history.window.newer]);
	useEffect(() => {
		if (history.window.older !== undefined && !history.older.loading && history.older.error === undefined && lastIndex !== undefined && lastIndex >= items.length - 6) void loadOlder();
	}, [history.older.error, history.older.loading, history.window.older, items.length, lastIndex]);

	if (history.initial.loading && items.length === 0) return <div className="text-[10px] text-[var(--text-muted)]">Loading history…</div>;
	if (history.initial.error !== undefined && items.length === 0) {
		return <HistoryError edge="history" error={history.initial.error} onRetry={history.retryInitial} />;
	}
	if (items.length === 0) return <div className="text-[10px] text-[var(--text-muted)]">{emptyLabel}</div>;

	return (
		<div className="grid gap-1.5" data-testid="virtualized-history" data-retained-items={items.length}>
		{history.newer.error !== undefined && <HistoryError edge="newer" error={history.newer.error} onRetry={loadNewer} />}
		{history.newer.loading && <div className="text-center text-[10px] text-[var(--text-muted)]">Loading newer…</div>}
		<div ref={parentRef} className={`overflow-auto overscroll-contain ${className}`}>
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
		{history.older.error !== undefined && <HistoryError edge="older" error={history.older.error} onRetry={loadOlder} />}
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
