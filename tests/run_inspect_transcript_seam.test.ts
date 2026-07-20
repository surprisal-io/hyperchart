import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { hyperchartRunFromRunDir } from "../packages/hyperchart/src/inspect/run_inspect.js";
import {
	readNeutralSessionTranscript,
	resolveContainedSessionFile,
} from "../packages/hyperchart/src/inspect/session_transcript.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRunDir(): { runDir: string; chartPath: string } {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-seam-"));
	roots.push(root);
	const chartPath = join(root, "seam.chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "seam", initial: "done", states: { done: final() } });
`,
	);
	const runDir = join(root, "run");
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	saveRunMeta(runDir, { chartPath, workDir: root, chartId: "seam", createdAt: new Date().toISOString() });
	return { runDir, chartPath };
}

describe("run inspection transcript seam", () => {
	it("uses an injected transcript reader for session messages", async () => {
		const { runDir } = makeRunDir();
		const sessionsDir = join(runDir, "sessions");
		const actionUid = { chart: "seam", state: "done", action: "agent" };
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: join(sessionsDir, "whatever.jsonl"),
		});

		const run = await hyperchartRunFromRunDir(runDir, {
			readTranscript: () => [{ id: "m1", role: "assistant", text: "injected" }],
		});

		const state = run.states.find((candidate) => candidate.id === "done");
		expect(state?.session?.messages).toEqual([{ id: "m1", role: "assistant", text: "injected" }]);
	});

	it("reads the neutral JSONL format by default and ignores unknown formats", async () => {
		const { runDir } = makeRunDir();
		const sessionsDir = join(runDir, "sessions");
		const neutralFile = join(sessionsDir, "neutral.jsonl");
		writeFileSync(
			neutralFile,
			[
				JSON.stringify({ hyperchartTranscript: 1, sessionId: "s1", createdAt: 1 }),
				JSON.stringify({ id: "u1", role: "user", text: "hi" }),
				JSON.stringify({ id: "t1", role: "tool", toolName: "read", toolCallId: "c1", toolInput: "{}", toolStatus: "running" }),
				JSON.stringify({ id: "t2", role: "tool", toolName: "read", toolCallId: "c1", toolOutput: "done", toolStatus: "completed" }),
			].join("\n"),
		);
		const foreignFile = join(sessionsDir, "foreign.jsonl");
		writeFileSync(foreignFile, `${JSON.stringify({ type: "message", id: "x" })}\n`);

		expect(readNeutralSessionTranscript(sessionsDir, neutralFile)).toEqual([
			{ id: "u1", role: "user", text: "hi" },
			{ id: "t1", role: "tool", toolName: "read", toolCallId: "c1", toolInput: "{}", toolStatus: "completed", toolOutput: "done" },
		]);
		expect(readNeutralSessionTranscript(sessionsDir, foreignFile)).toBeUndefined();

		const actionUid = { chart: "seam", state: "done", action: "agent" };
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: neutralFile,
		});
		const run = await hyperchartRunFromRunDir(runDir);
		const state = run.states.find((candidate) => candidate.id === "done");
		expect(state?.session?.messages?.[0]).toEqual({ id: "u1", role: "user", text: "hi" });
	});

	it("rejects session files outside the sessions directory", () => {
		const { runDir } = makeRunDir();
		const sessionsDir = join(runDir, "sessions");
		const outside = join(runDir, "outside.jsonl");
		writeFileSync(outside, "{}\n");
		expect(resolveContainedSessionFile(sessionsDir, outside)).toBeUndefined();
		const escapeLink = join(sessionsDir, "escape.jsonl");
		symlinkSync(outside, escapeLink);
		expect(resolveContainedSessionFile(sessionsDir, escapeLink)).toBeUndefined();
	});
});
