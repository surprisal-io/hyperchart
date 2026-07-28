import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRunLive, patchRunStatus, readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-status-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("run status", () => {
	it("persists heartbeat state and clears optional fields", async () => {
		const dir = await makeTempDir();
		patchRunStatus(dir, {
			runId: "run",
			chartId: "chart",
			state: "failed",
			attemptId: "attempt-a",
			error: "boom",
			exitCode: 1,
			heartbeatAt: 100,
		});
		patchRunStatus(dir, { state: "running", error: undefined, exitCode: undefined, heartbeatAt: Date.now() });

		const status = readRunStatus(dir);
		expect(status).toMatchObject({ runId: "run", chartId: "chart", state: "running", attemptId: "attempt-a" });
		expect(status?.error).toBeUndefined();
		expect(status?.exitCode).toBeUndefined();
		expect(isRunLive(status)).toBe(true);

		patchRunStatus(dir, { state: "starting", attemptId: "attempt-b" });
		expect(readRunStatus(dir)).toMatchObject({ state: "starting", attemptId: "attempt-b" });
	});
});
