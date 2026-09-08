/** @vitest-environment jsdom */
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperchartInspectorDataSource } from "../packages/hyperchart/src/host/adapter.js";
import type { HyperchartRecordInfo, HyperchartVisitInfo } from "../packages/hyperchart/src/host/models.js";
import { runningRun } from "../packages/hyperchart/src/react/fixtures/hyperchart-fixtures.js";
import { ActionVisitHistory } from "../packages/hyperchart/src/react/components/inspector/history/ActionVisitHistory.js";
import {
	actionStateContexts,
	actionVisitIndexes,
	actionVisitStatusLabel,
} from "../packages/hyperchart/src/react/components/inspector/helpers/actionVisits.js";

const snapshot = { branchId: "fork", headSeqId: 9 } as const;

function record(seqId: number, state: string, timestamp: number): HyperchartRecordInfo {
	return {
		seqId,
		parentId: seqId === 1 ? null : seqId - 1,
		branchId: seqId < 4 ? "main" : "fork",
		type: "state_action",
		timestamp,
		record: { type: "state_action", kind: "invoke", actionUid: { state } },
	};
}

function visit(
	invokeSeqId: number,
	stateVisit: number,
	status: HyperchartVisitInfo["status"],
	startedAt: number,
	endedReason?: HyperchartVisitInfo["endedReason"],
): HyperchartVisitInfo {
	return {
		visit: stateVisit,
		invokeSeqId,
		originBranchId: invokeSeqId < 4 ? "main" : "fork",
		startedAt,
		...(status === "running" ? {} : { endedAt: startedAt + 10 }),
		status,
		...(endedReason === undefined ? {} : { endedReason }),
		invocation: { kind: "agent" },
	};
}

afterEach(() => cleanup());

describe("Inspector action visit chronology", () => {
	it("orders repeated visits by durable invocation sequence, not timestamps", () => {
		const indexes = actionVisitIndexes([
			record(9, "research-plan", 100),
			record(5, "source-research", 5_000),
			record(2, "research-plan", 10_000),
		]);
		expect(indexes).toEqual([
			{ invokeSeqId: 2, statePath: "research-plan", originBranchId: "main" },
			{ invokeSeqId: 5, statePath: "source-research", originBranchId: "fork" },
			{ invokeSeqId: 9, statePath: "research-plan", originBranchId: "fork" },
		]);
	});

	it("indexes actor messaging actions at their durable enqueue sequence", () => {
		const messageRecord = {
			seqId: 7,
			parentId: 6,
			branchId: "fork",
			type: "actor_messages_enqueued",
			timestamp: 700,
			record: { type: "actor_messages_enqueued", source: { producerState: "dispatch" } },
		} as unknown as HyperchartRecordInfo;
		expect(actionVisitIndexes([messageRecord])).toEqual([
			{ invokeSeqId: 7, statePath: "dispatch", originBranchId: "fork" },
		]);
	});

	it("renders A1 → B1 → A2 as independently selectable semantic visits", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const records = [
			{ ...record(9, "research-plan", 100), actionVisit: visit(9, 2, "running", 100) },
			{ ...record(5, "source-research", 5_000), actionVisit: visit(5, 1, "cancelled", 5_000, "timed_out") },
			{ ...record(2, "research-plan", 10_000), actionVisit: visit(2, 1, "done", 10_000) },
		];
		const dataSource = {
			readRecords: vi.fn().mockResolvedValue({ snapshot, items: records }),
		} as unknown as HyperchartInspectorDataSource;
		const onSelectVisit = vi.fn();
		const run = { ...runningRun, branchId: "fork", historySnapshot: snapshot };
		render(createElement(ActionVisitHistory, { run, dataSource, onSelectVisit }));

		const first = await screen.findByRole("button", { name: "research-plan, Visit 1, Completed" });
		const middle = screen.getByRole("button", { name: "source-research, Visit 1, Cancelled · Timed out" });
		const last = screen.getByRole("button", { name: "research-plan, Visit 2, In progress" });
		expect(first.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(middle.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		fireEvent.click(last);
		expect(onSelectVisit).toHaveBeenCalledWith(
			expect.objectContaining({
				invokeSeqId: 9,
				statePath: "research-plan",
				visit: expect.objectContaining({ visit: 2 }),
			}),
		);
		expect(dataSource.readRecords).toHaveBeenCalledWith(expect.objectContaining({ includeActionVisits: true }));
	});

	it("restarts loading when a data source appears for the same run and snapshot", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const run = { ...runningRun, branchId: "fork", historySnapshot: snapshot };
		const dataSource = {
			readRecords: vi.fn().mockResolvedValue({
				snapshot,
				items: [{ ...record(5, "source-research", 5), actionVisit: visit(5, 1, "done", 5) }],
			}),
		} as unknown as HyperchartInspectorDataSource;
		const rendered = render(createElement(ActionVisitHistory, { run, onSelectVisit: vi.fn() }));
		expect(screen.getByRole("button", { name: "research-plan, Visit 1, Completed" })).toBeTruthy();
		rendered.rerender(createElement(ActionVisitHistory, { run, dataSource, onSelectVisit: vi.fn() }));
		await screen.findByRole("button", { name: "source-research, Visit 1, Completed" });
		expect(dataSource.readRecords).toHaveBeenCalledTimes(1);
	});

	it("restarts loading when the data-source identity changes at the same snapshot", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const run = { ...runningRun, branchId: "fork", historySnapshot: snapshot };
		const sourceA = {
			readRecords: vi.fn().mockResolvedValue({
				snapshot,
				items: [{ ...record(2, "research-plan", 2), actionVisit: visit(2, 1, "done", 2) }],
			}),
		} as unknown as HyperchartInspectorDataSource;
		const sourceB = {
			readRecords: vi.fn().mockResolvedValue({
				snapshot,
				items: [{ ...record(5, "source-research", 5), actionVisit: visit(5, 1, "done", 5) }],
			}),
		} as unknown as HyperchartInspectorDataSource;
		const rendered = render(createElement(ActionVisitHistory, { run, dataSource: sourceA, onSelectVisit: vi.fn() }));
		await screen.findByRole("button", { name: "research-plan, Visit 1, Completed" });
		rendered.rerender(createElement(ActionVisitHistory, { run, dataSource: sourceB, onSelectVisit: vi.fn() }));
		await screen.findByRole("button", { name: "source-research, Visit 1, Completed" });
		expect(screen.queryByRole("button", { name: "research-plan, Visit 1, Completed" })).toBeNull();
		expect(sourceA.readRecords).toHaveBeenCalledTimes(1);
		expect(sourceB.readRecords).toHaveBeenCalledTimes(1);
	});

	it("keeps Older available through a record page that contains no invocations", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const dataSource = {
			readRecords: vi.fn(async ({ cursor }: { cursor?: string }) =>
				cursor === undefined
					? {
							snapshot,
							items: [
								{
									seqId: 9,
									parentId: 8,
									branchId: "fork",
									type: "state_action",
									timestamp: 9,
									record: { type: "state_action", kind: "complete" },
								},
							],
							older: "older-page",
						}
					: { snapshot, items: [{ ...record(2, "research-plan", 2), actionVisit: visit(2, 1, "done", 2) }] },
			),
		} as unknown as HyperchartInspectorDataSource;
		const run = { ...runningRun, branchId: "fork", historySnapshot: snapshot };
		render(createElement(ActionVisitHistory, { run, dataSource, onSelectVisit: vi.fn(), mobile: true }));
		expect(screen.getByRole("region", { name: "Action visit history" })).toBeTruthy();
		await screen.findByText("No action visits in this loaded record range.");
		expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
		expect(screen.getByRole("button", { name: "Older" }).className).toContain("min-h-11");
		fireEvent.click(screen.getByRole("button", { name: "Older" }));
		await screen.findByRole("button", { name: "research-plan, Visit 1, Completed" });
		expect(dataSource.readRecords).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "older-page" }));
	});

	it("rejects a deferred response from the previously selected branch", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const oldSnapshot = { branchId: "main", headSeqId: 2 } as const;
		const newSnapshot = { branchId: "fork-new", headSeqId: 5 } as const;
		let resolveOld: ((value: unknown) => void) | undefined;
		let resolveNew: ((value: unknown) => void) | undefined;
		const dataSource = {
			readRecords: vi.fn(
				({ snapshot: requested }: { snapshot: typeof oldSnapshot | typeof newSnapshot }) =>
					new Promise((resolve) => {
						if (requested.branchId === "main") resolveOld = resolve;
						else resolveNew = resolve;
					}),
			),
		} as unknown as HyperchartInspectorDataSource;
		const rendered = render(
			createElement(ActionVisitHistory, {
				run: { ...runningRun, branchId: "main", historySnapshot: oldSnapshot },
				dataSource,
				onSelectVisit: vi.fn(),
			}),
		);
		rendered.rerender(
			createElement(ActionVisitHistory, {
				run: { ...runningRun, branchId: "fork-new", historySnapshot: newSnapshot },
				dataSource,
				onSelectVisit: vi.fn(),
			}),
		);
		await act(async () =>
			resolveNew?.({
				snapshot: newSnapshot,
				items: [{ ...record(5, "source-research", 5), branchId: "fork-new", actionVisit: visit(5, 1, "done", 5) }],
			}),
		);
		await screen.findByRole("button", { name: "source-research, Visit 1, Completed" });
		await act(async () =>
			resolveOld?.({
				snapshot: oldSnapshot,
				items: [{ ...record(2, "research-plan", 2), actionVisit: visit(2, 1, "done", 2) }],
			}),
		);
		expect(screen.queryByRole("button", { name: "research-plan, Visit 1, Completed" })).toBeNull();
		expect(screen.getByRole("button", { name: "source-research, Visit 1, Completed" })).toBeTruthy();
	});

	it("keeps state context separate and never labels cancellations as skipped", () => {
		expect(
			actionStateContexts([
				{
					id: "active",
					type: "agent",
					status: "running",
					runtimeSummary: {
						status: "running",
						visitCount: 1,
						hasOlderRuntime: false,
						issueCount: 0,
						actorMessageCount: 0,
					},
				},
				{
					id: "waiting",
					type: "user",
					status: "waiting",
					runtimeSummary: {
						status: "waiting",
						visitCount: 0,
						hasOlderRuntime: false,
						issueCount: 0,
						actorMessageCount: 0,
					},
				},
				{
					id: "future",
					type: "script",
					status: "pending",
					runtimeSummary: {
						status: "pending",
						visitCount: 0,
						hasOlderRuntime: false,
						issueCount: 0,
						actorMessageCount: 0,
					},
				},
			]),
		).toEqual([
			{ stateId: "active", label: "Active" },
			{ stateId: "waiting", label: "Waiting" },
			{ stateId: "future", label: "Pending—not guaranteed to execute" },
		]);
		expect(actionVisitStatusLabel(visit(7, 1, "cancelled", 1, "scope_exit"))).toBe("Cancelled · Scope exited");
		expect(actionVisitStatusLabel(visit(8, 2, "cancelled", 1, "timed_out"))).toBe("Cancelled · Timed out");
	});
});
