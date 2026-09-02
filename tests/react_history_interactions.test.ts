/** @vitest-environment jsdom */
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HyperchartInspectorDataSource } from "../packages/hyperchart/src/host/adapter.js";
import { RuntimeSection, useTargetCursor } from "../packages/hyperchart/src/react/components/inspector/details/RuntimeSection.js";
import { VisitHistory } from "../packages/hyperchart/src/react/components/inspector/details/VisitHistory.js";
import { captureHistoryScrollAnchor, restoreHistoryScrollTop, VirtualizedHistoryList } from "../packages/hyperchart/src/react/components/inspector/history/VirtualizedHistoryList.js";
import { mergeHistoryWindow, useHistoryWindow } from "../packages/hyperchart/src/react/components/inspector/history/useHistoryWindow.js";
import type { HistoryChunk, HistoryCursor } from "../packages/hyperchart/src/runtime/generic/log_store.js";

const snapshot = { branchId: "main", headSeqId: 20_000 } as const;
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 });
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "320") || 320; } });
	HTMLElement.prototype.getBoundingClientRect = function () {
		const key = this.getAttribute("data-history-row");
		const height = this.classList.contains("overflow-auto") ? 320 : key !== null && Number(key) % 3 === 0 ? 140 : 52;
		return { x: 0, y: 0, width: 800, height, top: 0, right: 800, bottom: height, left: 0, toJSON() {} };
	};
	HTMLElement.prototype.scrollTo = function (first?: number | ScrollToOptions, second?: number) { this.scrollTop = typeof first === "number" ? second ?? 0 : first?.top ?? 0; };
	vi.stubGlobal("ResizeObserver", class {
		constructor(private readonly callback: ResizeObserverCallback) {}
		observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); }
		unobserve() {}
		disconnect() {}
	});
});
afterEach(() => cleanup());
afterAll(() => { HTMLElement.prototype.getBoundingClientRect = originalRect; HTMLElement.prototype.scrollTo = originalScrollTo; vi.unstubAllGlobals(); });

function rows(start: number, count: number) { return Array.from({ length: count }, (_, index) => ({ id: start + index })); }
const RowHistoryList = VirtualizedHistoryList<{ id: number }>;

function pagedChunk(page: number): HistoryChunk<{ id: number }> {
	return { snapshot, items: rows(page * 100, 100), ...(page < 19 ? { older: `page:${page + 1}` } : {}), ...(page > 0 ? { newer: `page:${page - 1}` } : {}) };
}

describe("interactive bounded history", () => {
	it("loads both directions, evicts above 1,000, and reloads the evicted edge", async () => {
		const calls: Array<HistoryCursor | undefined> = [];
		const source = { load: async (cursor?: HistoryCursor) => { calls.push(cursor); return pagedChunk(cursor === undefined ? 0 : Number(cursor.split(":")[1])); } };
		const { result } = renderHook(() => useHistoryWindow({ cacheKey: "main:head", source, identity: (item) => String(item.id) }));
		await waitFor(() => expect(result.current.window.items).toHaveLength(100));
		for (let page = 1; page <= 11; page++) await act(() => result.current.loadOlder());
		expect(result.current.window.items).toHaveLength(1_000);
		expect(result.current.window.items[0]?.id).toBe(200);
		expect(result.current.window.newer).toBeDefined();
		await act(() => result.current.loadNewer());
		expect(result.current.window.items).toHaveLength(1_000);
		expect(result.current.window.items[0]?.id).toBe(100);
		expect(new Set(result.current.window.items.map((item) => item.id)).size).toBe(1_000);
		expect(calls).toHaveLength(13);
	});

	it("preserves durable anchor identity and exact variable-height pixel offset across opposite-edge eviction and reload", () => {
		const identity = (item: { id: number }) => String(item.id);
		let window = mergeHistoryWindow({ segments: [] }, { snapshot, items: rows(200, 100), newer: "page:1", older: "page:3" }, "initial", identity);
		for (let page = 3; page <= 11; page++) window = mergeHistoryWindow(window, pagedChunk(page), "older", identity);
		const beforeAppend = window.segments.flatMap((segment) => segment.items);
		expect(beforeAppend).toHaveLength(1_000);
		const heights = (items: readonly { id: number }[], end: number) => items.slice(0, end).reduce((total, item) => total + (item.id % 3 === 0 ? 140 : 52), 0);
		const appendAnchorIndex = beforeAppend.findIndex((item) => item.id === 1_100);
		const appendStart = heights(beforeAppend, appendAnchorIndex);
		const appendAnchor = captureHistoryScrollAnchor(beforeAppend.map(identity), [{ index: appendAnchorIndex, start: appendStart }], appendStart + 19);
		expect(appendAnchor).toEqual({ key: "1100", pixelOffset: 19 });

		window = mergeHistoryWindow(window, pagedChunk(12), "older", identity);
		const afterAppend = window.segments.flatMap((segment) => segment.items);
		expect(afterAppend).toHaveLength(1_000);
		expect(afterAppend[0]?.id).toBe(300);
		const appendRestoredIndex = afterAppend.findIndex((item) => identity(item) === appendAnchor?.key);
		const appendRestoredStart = heights(afterAppend, appendRestoredIndex);
		expect(restoreHistoryScrollTop(appendAnchor!, afterAppend.map(identity), (index) => heights(afterAppend, index))).toBe(appendRestoredStart + 19);

		const reloadAnchorIndex = afterAppend.findIndex((item) => item.id === 350);
		const reloadStart = heights(afterAppend, reloadAnchorIndex);
		const reloadAnchor = captureHistoryScrollAnchor(afterAppend.map(identity), [{ index: reloadAnchorIndex, start: reloadStart }], reloadStart + 7);
		window = mergeHistoryWindow(window, { snapshot, items: rows(200, 100), newer: "page:1", older: "page:3" }, "newer", identity);
		const afterReload = window.segments.flatMap((segment) => segment.items);
		expect(afterReload).toHaveLength(1_000);
		expect(afterReload[0]?.id).toBe(200);
		expect(afterReload.at(-1)?.id).toBe(1_199);
		const reloadRestoredIndex = afterReload.findIndex((item) => identity(item) === reloadAnchor?.key);
		const reloadRestoredStart = heights(afterReload, reloadRestoredIndex);
		expect(restoreHistoryScrollTop(reloadAnchor!, afterReload.map(identity), (index) => heights(afterReload, index))).toBe(reloadRestoredStart + 7);
	});

	it("drops stale responses across subject, snapshot, and branch cache changes", async () => {
		const resolvers = new Map<string, (chunk: HistoryChunk<{ id: number }>) => void>();
		const source = { load: (cursor?: HistoryCursor) => new Promise<HistoryChunk<{ id: number }>>((resolve) => resolvers.set(cursor ?? "initial", resolve)) };
		const { result, rerender } = renderHook(({ cacheKey, cursor }) => useHistoryWindow({ cacheKey, source, identity: (item) => String(item.id), initialCursor: cursor }), { initialProps: { cacheKey: "run:main:1:state:a", cursor: "old" } });
		rerender({ cacheKey: "run:fork:2:state:b", cursor: "new" });
		await act(async () => resolvers.get("new")?.({ snapshot: { branchId: "fork", headSeqId: 2 }, items: [{ id: 2 }] }));
		await waitFor(() => expect(result.current.window.items).toEqual([{ id: 2 }]));
		await act(async () => resolvers.get("old")?.({ snapshot: { branchId: "main", headSeqId: 1 }, items: [{ id: 1 }] }));
		expect(result.current.window.items).toEqual([{ id: 2 }]);
	});

	it("stops automatic edge retries until the explicit Retry action", async () => {
		let calls = 0;
		const source = { load: async (cursor?: HistoryCursor) => {
			calls += 1;
			if (cursor !== undefined && calls <= 2) throw new Error("persistent edge failure");
			return { snapshot, items: cursor === undefined ? rows(0, 8) : rows(8, 2), ...(cursor === undefined ? { older: "older" } : {}) };
		} };
		render(createElement(RowHistoryList, { cacheKey: "retry", source, identity: (item: { id: number }) => String(item.id), renderItem: (item: { id: number }) => createElement("div", null, item.id) }));
		const list = await screen.findByTestId("virtualized-history");
		const viewport = list.querySelector(".overflow-auto");
		if (viewport === null) throw new Error("history viewport missing");
		fireEvent.scroll(viewport, { target: { scrollTop: 500 } });
		await screen.findByText(/older load failed/);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toBe(2);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(calls).toBe(3));
		await waitFor(() => expect(screen.queryByText(/older load failed/)).toBeNull());
	});

	it("refreshes a production RuntimeSection after older pages without changing the selected state subject", async () => {
		const calls: Array<{ stateId: string; headSeqId: number; cursor?: HistoryCursor }> = [];
		const visitRows = (start: number, count = 8) => Array.from({ length: count }, (_, index) => ({ visit: start + index, invokeSeqId: start + index, startedAt: start + index, status: "done" as const, invocation: { kind: "script" as const, command: "node", args: ["-e", "process.exit(0)"] } }));
		const dataSource = {
			readStateVisits: vi.fn(async (input: { stateId: string; snapshot: typeof snapshot; cursor?: HistoryCursor }) => {
				calls.push({ stateId: input.stateId, headSeqId: input.snapshot.headSeqId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
				return input.cursor === undefined
					? { snapshot: input.snapshot, items: visitRows(input.snapshot.headSeqId), older: "older:selected-work" }
					: { snapshot: input.snapshot, items: visitRows(input.snapshot.headSeqId - 100), newer: "newer:selected-work" };
			}),
			readVisitSession: vi.fn(),
		} as unknown as HyperchartInspectorDataSource;
		const state = { id: "selected-work", type: "script" as const, status: "running" as const, startedAt: 1 };
		const firstHistory = { runId: "run", snapshot: { branchId: "main", headSeqId: 200 } as const, dataSource };
		const rendered = render(createElement(RuntimeSection, { state, history: firstHistory }));
		fireEvent.click(rendered.getByRole("button", { name: /Runtime/ }));
		await rendered.findByTestId("virtualized-history");
		await waitFor(() => expect(calls).toEqual([
			{ stateId: "selected-work", headSeqId: 200 },
			{ stateId: "selected-work", headSeqId: 200, cursor: "older:selected-work" },
		]));

		const refreshedHistory = { runId: "run", snapshot: { branchId: "main", headSeqId: 300 } as const, dataSource };
		rendered.rerender(createElement(RuntimeSection, { state, history: refreshedHistory }));
		await waitFor(() => expect(calls).toEqual([
			{ stateId: "selected-work", headSeqId: 200 },
			{ stateId: "selected-work", headSeqId: 200, cursor: "older:selected-work" },
			{ stateId: "selected-work", headSeqId: 300 },
		]));
		expect(calls.every((call) => call.stateId === "selected-work")).toBe(true);
		expect(rendered.getByTestId("virtualized-history").getAttribute("data-retained-items")).toBe("8");
	});

	it("keeps resolved map items while exposing lazy launch history separately", async () => {
		const state = { id: "items", type: "map" as const, status: "running" as const, mapConfig: { items: [{ key: "a", label: "Resolved Alpha", value: { result: "kept" } }] } };
		const history = { runId: "run", snapshot, dataSource: {} as HyperchartInspectorDataSource };
		const rendered = render(createElement(RuntimeSection, { state, history }));
		fireEvent.click(rendered.getByRole("button", { name: /Runtime/ }));
		expect(rendered.getAllByText("Resolved Alpha").length).toBeGreaterThan(0);
		expect(rendered.getByRole("button", { name: "Load map launch history" })).toBeTruthy();
	});

	it("loads a visit transcript only when its session is opened", async () => {
		const readVisitSession = vi.fn().mockResolvedValue({ actionKey: "chart:work:agent", status: "completed", messages: [{ role: "assistant", text: "on demand transcript" }] });
		const visit = { visit: 1, invokeSeqId: 7, startedAt: 1, status: "done" as const, invocation: { kind: "agent" as const }, session: { actionKey: "chart:work:agent", status: "completed" as const } };
		const state = { id: "work", type: "agent" as const, status: "done" as const };
		const rendered = render(createElement(VisitHistory, { visits: [visit], state, allStates: [state], onReadSession: readVisitSession }));
		expect(readVisitSession).not.toHaveBeenCalled();
		fireEvent.click(rendered.getByRole("button", { name: "View session for visit 1" }));
		await waitFor(() => expect(readVisitSession).toHaveBeenCalledWith(7));
		await rendered.findByText("on demand transcript");
	});

	it("shows per-invocation transcript rejection and retries exactly once to recovery", async () => {
		let rejectFirst: ((error: Error) => void) | undefined;
		const readVisitSession = vi.fn()
			.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
			.mockResolvedValueOnce({ actionKey: "chart:work:agent", status: "completed", messages: [{ role: "assistant", text: "recovered transcript" }] });
		const visit = { visit: 1, invokeSeqId: 17, startedAt: 1, status: "done" as const, invocation: { kind: "agent" as const }, session: { actionKey: "chart:work:agent", status: "completed" as const } };
		const state = { id: "work", type: "agent" as const, status: "done" as const };
		const rendered = render(createElement(VisitHistory, { visits: [visit], state, allStates: [state], onReadSession: readVisitSession }));
		fireEvent.click(rendered.getByRole("button", { name: "View session for visit 1" }));
		expect(rendered.getByRole("status").textContent).toBe("Loading transcript…");
		fireEvent.click(rendered.getByRole("button", { name: "View session for visit 1" }));
		expect(readVisitSession).toHaveBeenCalledTimes(1);
		await act(async () => rejectFirst?.(new Error("transcript backend offline")));
		await rendered.findByText("Transcript load failed: transcript backend offline");
		expect(readVisitSession).toHaveBeenCalledTimes(1);
		expect(readVisitSession).toHaveBeenLastCalledWith(17);
		expect(rendered.queryByText("recovered transcript")).toBeNull();
		fireEvent.click(rendered.getByRole("button", { name: "Retry" }));
		await rendered.findByText("recovered transcript");
		expect(readVisitSession).toHaveBeenCalledTimes(2);
		expect(readVisitSession).toHaveBeenLastCalledWith(17);
		expect(rendered.queryByText(/Transcript load failed/)).toBeNull();
	});

	it("reports cursor lookup rejection and succeeds only after explicit retry", async () => {
		let calls = 0;
		const dataSource = { cursorAt: async () => { calls += 1; if (calls === 1) throw new Error("lookup offline"); return "cursor:9"; } } as unknown as HyperchartInspectorDataSource;
		const history = { runId: "run", snapshot, dataSource, targetSeqId: 9 };
		const { result } = renderHook(() => useTargetCursor(history, { kind: "state-visits", state: "work" }));
		await waitFor(() => expect(result.current.ready && "error" in result.current ? result.current.error : undefined).toBe("lookup offline"));
		expect(calls).toBe(1);
		act(() => { if ("retry" in result.current) result.current.retry(); });
		await waitFor(() => expect(result.current.ready && "cursor" in result.current ? result.current.cursor : undefined).toBe("cursor:9"));
		expect(calls).toBe(2);
	});
});
