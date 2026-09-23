import { expect, it } from "vitest";
import { captureStorySchedule } from "../../scripts/story-fixtures/capture-story-schedule.js";
import { actorCallAst, actorNamedReplyRecords } from "../../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import { readFileSync } from "node:fs";
import captured from "../../packages/hyperchart/src/react/fixtures/captured-story-records.json" with { type: "json" };
import { scenario, records, secondRecords } from "../../packages/hyperchart/src/react/fixtures/runtime-section-fixture.js";
import {
	plainScenario,
	plainPrefix,
	plainStateRecords,
} from "../../packages/hyperchart/src/react/fixtures/no-input-records-fixture.js";
import { explainReplay } from "../../packages/hyperchart/src/core/replay_check.js";
import { createBranchProjection, projectBranch } from "../../packages/hyperchart/src/core/projection.js";
import type { DurableLogRecord } from "../../packages/hyperchart/src/core/durable_events.js";
import {
	emitStoryRecords,
	emitStoryRun,
	mapEmitStoryRecords,
	mapEmitStoryRun,
	pendingGateRecords,
	resolvedGateRecords,
	resolvedGateRun,
	validatedEmitStoryRecords,
	validatedEmitStoryRun,
} from "../../packages/hyperchart/src/react/fixtures/gate-emit-fixtures.js";

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
		new URL("../../packages/hyperchart/src/react/fixtures/capture-story-schedule.ts", import.meta.url),
		"utf8",
	);
	expect(loader).not.toContain("execution_loop");
	expect(loader).not.toContain("async ");

	expect(pendingGateRecords.at(-1)).toMatchObject({
		type: "gate",
		kind: "opened",
		event: "release.approval-requested",
	});
	expect(resolvedGateRecords.map((record) => record.type)).toEqual([
		"args",
		"state_action",
		"gate",
		"gate",
		"emit",
		"state_action",
	]);
	expect(emitStoryRecords.slice(-2)).toMatchObject([
		{ type: "emit", event: "release.published" },
		{ type: "emit", event: "release.metrics-recorded" },
	]);
	const published = emitStoryRecords.find((record) => record.type === "emit" && record.event === "release.published");
	expect(published).toMatchObject({
		payload: {
			release: {
				environment: "production",
				state: { nestedPath: "releases/2026.09.18/manifest.json", status: "ready" },
			},
			entries: [
				{ type: "literal", label: "signed" },
				{ type: "result", label: "releases/2026.09.18/manifest.json" },
				{ type: "input", label: "releases/2026.09.18" },
				{ type: "argument", label: "production" },
				{ type: "visit", ordinal: 1 },
			],
			metrics: { attempts: 2, verified: true, absent: null },
		},
	});
	expect(
		mapEmitStoryRecords.find((record) => record.type === "emit" && record.event === "release.item-published"),
	).toMatchObject({
		actionUid: { state: "publish-map#0.announce" },
		payload: {
			mapKey: "0",
			item: { field: "manifest", priority: "high" },
			accepted: true,
			environment: "production",
			visit: 1,
		},
	});
	const positiveVerdict = validatedEmitStoryRecords.findIndex(
		(record) => record.type === "state_action" && record.kind === "validated" && record.outcome === true,
	);
	const validatedEmit = validatedEmitStoryRecords.findIndex((record) => record.type === "emit");
	expect(positiveVerdict).toBeGreaterThanOrEqual(0);
	expect(validatedEmit).toBeGreaterThan(positiveVerdict);

	const visit = emitStoryRun.states.find((state) => state.id === "publish")?.visitHistory?.[0];
	expect(visit?.completedOutput).toMatchObject({ releaseId: "release-2026.09.18", artifactCount: 7 });
	expect(visit?.emits?.map(({ event }) => event)).toEqual(["release.published", "release.metrics-recorded"]);
	expect(
		mapEmitStoryRun.states.find((state) => state.id === "publish-map#0.announce")?.visitHistory?.[0],
	).toMatchObject({
		completedOutput: { accepted: true },
		emits: [{ event: "release.item-published" }],
	});
	expect(validatedEmitStoryRun.states.find((state) => state.id === "publish")?.visitHistory?.[0]).toMatchObject({
		completedOutput: { releaseId: "release-2026.09.18", artifactCount: 7 },
		emits: [{ event: "release.validated-publish" }],
	});
	expect(resolvedGateRun.states.find((state) => state.id === "release-gate")?.visitHistory?.[0]).toMatchObject({
		completedOutput: { approvedBy: "release-control@surprisal.dev" },
		emits: [{ event: "release.approved" }],
	});
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
