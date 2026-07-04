import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionProgress, updateSessionProgress } from "../src/runtime/pi/session_progress.js";

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

		updateSessionProgress(dir, actionUid, {
			actionName: "reviewer",
			status: "running",
			turnCount: 1,
			currentTool: "read",
			currentToolArgs: '{"path":"src/index.ts"}',
			currentToolStartedAt: 123,
		});
		updateSessionProgress(dir, actionUid, {
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartedAt: undefined,
			toolCount: 1,
			tokenCount: 1234,
		});

		const progress = readSessionProgress(dir).sessions["chart:review.correctness.scan:agent"];
		expect(progress).toMatchObject({
			actionName: "reviewer",
			status: "running",
			turnCount: 1,
			toolCount: 1,
			tokenCount: 1234,
		});
		expect(progress?.currentTool).toBeUndefined();
		expect(progress?.currentToolArgs).toBeUndefined();
		expect(progress?.currentToolStartedAt).toBeUndefined();
	});
});
