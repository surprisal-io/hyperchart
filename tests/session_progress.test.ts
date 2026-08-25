import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readSessionProgress,
	sessionProgressKey,
	updateSessionProgress,
} from "../packages/hyperchart/src/runtime/generic/session_progress.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-progress-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session progress", () => {
	it("merges progress updates and allows clearing transient tool fields", async () => {
		const dir = await makeTempDir();
		const actionUid = { chart: "chart", state: "review.correctness.scan", action: "agent" };
		const effectId = "chart:review.correctness.scan:agent:1:2";

		updateSessionProgress(dir, actionUid, {
			actionName: "reviewer",
			status: "running",
			role: "reviewer",
			model: "provider/model",
			toolset: "reading",
			tools: ["read", "finish"],
			turnCount: 1,
			currentTool: "read",
			currentToolArgs: '{"path":"src/index.ts"}',
			currentToolStartedAt: 123,
		}, effectId);
		updateSessionProgress(dir, actionUid, {
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartedAt: undefined,
			toolCount: 1,
			tokenCount: 1234,
		}, effectId);

		const key = sessionProgressKey(actionUid, effectId);
		const progress = readSessionProgress(dir).sessions[key];
		expect(progress).toMatchObject({
			actionName: "reviewer",
			status: "running",
			role: "reviewer",
			model: "provider/model",
			toolset: "reading",
			tools: ["read", "finish"],
			turnCount: 1,
			toolCount: 1,
			tokenCount: 1234,
		});
		expect(progress?.currentTool).toBeUndefined();
		expect(progress?.currentToolArgs).toBeUndefined();
		expect(progress?.currentToolStartedAt).toBeUndefined();

		updateSessionProgress(dir, actionUid, {
			status: "starting",
			role: undefined,
			model: undefined,
			thinking: undefined,
			toolset: undefined,
			tools: undefined,
		}, effectId);
		const restarted = readSessionProgress(dir).sessions[key];
		expect(restarted?.role).toBeUndefined();
		expect(restarted?.model).toBeUndefined();
		expect(restarted?.toolset).toBeUndefined();
		expect(restarted?.tools).toBeUndefined();
	});

	it("keeps one independent session record for every durable visit", async () => {
		const dir = await makeTempDir();
		const actionUid = { chart: "chart", state: "work", action: "agent" };
		const firstEffect = "chart:work:agent:1:2";
		const secondEffect = "chart:work:agent:2:9";

		updateSessionProgress(
			dir,
			actionUid,
			{ actionName: "worker", status: "completed", sessionFile: "visit-1.jsonl", startedAt: 100 },
			firstEffect,
		);
		updateSessionProgress(
			dir,
			actionUid,
			{ actionName: "worker", status: "running", sessionFile: "visit-2.jsonl", startedAt: 200 },
			secondEffect,
		);

		const progress = readSessionProgress(dir);
		expect(sessionProgressKey(actionUid, firstEffect)).toBe("main:chart:work:agent:invoke:2");
		expect(progress.sessions["main:chart:work:agent:invoke:2"]).toMatchObject({
			actionKey: "chart:work:agent",
			branchId: "main",
			invokeSeqId: 2,
			visit: 1,
			status: "completed",
			sessionFile: "visit-1.jsonl",
		});
		expect(progress.sessions["main:chart:work:agent:invoke:9"]).toMatchObject({
			actionKey: "chart:work:agent",
			branchId: "main",
			invokeSeqId: 9,
			visit: 2,
			status: "running",
			sessionFile: "visit-2.jsonl",
		});
	});
});
