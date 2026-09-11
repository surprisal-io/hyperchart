import { expect, it } from "vitest";
import { captureStorySchedule } from "../scripts/story-fixtures/capture-story-schedule.js";
import { actorCallAst, actorNamedReplyRecords } from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import { readFileSync } from "node:fs";
import captured from "../packages/hyperchart/src/react/fixtures/captured-story-records.json" with { type: "json" };
import { scenario, records, secondRecords } from "../packages/hyperchart/src/react/fixtures/runtime-section-fixture.js";
import {
	plainScenario,
	plainPrefix,
	plainStateRecords,
} from "../packages/hyperchart/src/react/fixtures/no-input-records-fixture.js";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";

it("loads actual offline captures synchronously with explicit invocation policies", () => {
	expect(captured.captureContext.uuidSeed).toBe("hyperchart-story-capture-v1");
	expect(Object.keys(captured.snapshots).length).toBeGreaterThan(50);
	for (const snapshot of Object.values(captured.snapshots)) {
		for (const record of snapshot as DurableLogRecord[]) {
			if (record.type === "state_action" && record.kind === "invoke") {
				expect(record.definition).toBeDefined();
			}
		}
	}
	const loader = readFileSync(
		new URL("../packages/hyperchart/src/react/fixtures/capture-story-schedule.ts", import.meta.url),
		"utf8",
	);
	expect(loader).not.toContain("execution_loop");
	expect(loader).not.toContain("async ");
});

it("replays Runtime Section re-entry and no-input user completion from recaptured facts", () => {
	for (const [ast, log, leaf] of [
		[scenario.ast, records, "research"],
		[scenario.ast, secondRecords, "second"],
		[plainScenario.ast, plainPrefix, "approval"],
		[plainScenario.ast, plainStateRecords, "work"],
	] as const) {
		expect(explainReplay(ast, log)).toMatchObject({ prefixEnd: log.length, skipped: [], stale: [] });
		expect(projectBranch(createBranchProjection(ast), ast, log).activeLeaves).toEqual([leaf]);
	}
	expect(plainStateRecords.some((record) => record.type === "user_interaction" && record.kind === "resolved")).toBe(
		true,
	);
	expect(
		scenario
			.runtimeRun(records)
			.states.find((state) => state.id === "research")
			?.visitHistory?.map((visit) => visit.status),
	).toEqual(["done", "running"]);
});

it.each([
	"replied",
	"settled",
] as const)("rounds a %s capture selector to the full atomic reply commit", async (kind) => {
	const index = actorNamedReplyRecords.findIndex((record) => record.type === "actor_message" && record.kind === kind);
	expect(index).toBeGreaterThanOrEqual(0);
	const selected = actorNamedReplyRecords[index]!;
	if (selected.type !== "actor_message") {
		throw new Error("Expected actor message selector");
	}
	const recaptured = await captureStorySchedule(actorCallAst, actorNamedReplyRecords.slice(0, index + 1));
	for (const records of [recaptured, actorNamedReplyRecords]) {
		expect(records.slice(-3)).toMatchObject([
			{ type: "actor_message", kind: "replied", messageId: selected.messageId },
			{ type: "actor_message", kind: "settled", messageId: selected.messageId },
			{ type: "actor_call_resolved", messageId: selected.messageId },
		]);
		const [reply, settled, resolved] = records.slice(-3);
		expect(settled?.parentId).toBe(reply?.seqId);
		expect(resolved?.parentId).toBe(settled?.seqId);
		// The committed boundary precedes acknowledgement: no successor closing
		// effect is executed, but replay sees the entire call-resolution commit.
		expect(records.some((record) => record.type === "actor_scope")).toBe(false);
		expect(explainReplay(actorCallAst, records).broken).toBeUndefined();
		const projection = projectBranch(createBranchProjection(actorCallAst), actorCallAst, records);
		expect(projection.pendingActorCalls).toEqual({});
		expect(projection.activeLeaves).toEqual(["done"]);
	}
});
