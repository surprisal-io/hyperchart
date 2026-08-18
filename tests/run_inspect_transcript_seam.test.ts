import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../packages/hyperchart/src/core/action_uid.js";
import { branchSessionSegment } from "../packages/hyperchart/src/runtime/generic/executor_helpers.js";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { hyperchartRunFromRunDir } from "../packages/hyperchart/src/inspect/run_inspect.js";
import {
	limitTranscriptMessages,
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
	it("omits transcript payloads by default and loads them only when explicitly requested", async () => {
		const { runDir } = makeRunDir();
		const sessionsDir = join(runDir, "sessions");
		const actionUid = { chart: "seam", state: "done", action: "agent" };
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: join(sessionsDir, "whatever.jsonl"),
		});
		const readTranscript = vi.fn(() => [{ id: "m1", role: "assistant" as const, text: "injected" }]);

		const compact = await hyperchartRunFromRunDir(runDir, { readTranscript });
		const compactState = compact.states.find((candidate) => candidate.id === "done");
		expect(compactState?.session).toMatchObject({ actionKey: "seam:done:agent", status: "running" });
		expect(compactState?.session?.messages).toBeUndefined();
		expect(readTranscript).not.toHaveBeenCalled();

		const full = await hyperchartRunFromRunDir(runDir, { readTranscript, includeTranscripts: true });
		const fullState = full.states.find((candidate) => candidate.id === "done");
		expect(fullState?.session?.messages).toEqual([{ id: "m1", role: "assistant", text: "injected" }]);
		expect(readTranscript).toHaveBeenCalled();
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
		const run = await hyperchartRunFromRunDir(runDir, { includeTranscripts: true });
		const state = run.states.find((candidate) => candidate.id === "done");
		expect(state?.session?.messages?.[0]).toEqual({ id: "u1", role: "user", text: "hi" });
	});

	it("can read a full neutral transcript for visit segmentation while keeping the compact default", () => {
		const { runDir } = makeRunDir();
		const sessionsDir = join(runDir, "sessions");
		const file = join(sessionsDir, "long-neutral.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ hyperchartTranscript: 1, sessionId: "long", createdAt: 1 }),
				...Array.from({ length: 130 }, (_, index) =>
					JSON.stringify({ id: `m${index}`, role: "assistant", text: `message ${index}`, timestamp: index }),
				),
			].join("\n"),
		);

		expect(readNeutralSessionTranscript(sessionsDir, file)).toHaveLength(120);
		expect(readNeutralSessionTranscript(sessionsDir, file)?.[0]?.id).toBe("m10");
		expect(readNeutralSessionTranscript(sessionsDir, file, { limit: false })).toHaveLength(130);
	});

	it("reconstructs every visit session from branch-scoped invocation directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-visit-sessions-"));
		roots.push(root);
		const chartPath = join(root, "visits.chart.ts");
		writeFileSync(
			chartPath,
			`import { agent, chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "visits", initial: "work", states: {
  work: { kind: "state", action: agent("worker", { task: "work" }), transitions: { AGAIN: "work", DONE: "done" } },
  done: final(),
} });
`,
		);
		const runDir = join(root, "run");
		const sessionsDir = join(runDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: root, chartId: "visits", createdAt: new Date().toISOString() });
		const actionUid = { chart: "visits", state: "work", action: "agent" };
		const definition = { kind: "agent", uid: actionUid, name: "worker", task: "work" };
		const records = [
			{ type: "args", args: {}, parentId: null, seqId: 1, branchId: "main", timestamp: 1000 },
			{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 1, seqId: 2, branchId: "main", timestamp: 2000 },
			{ type: "state_action", kind: "complete", actionUid, event: { type: "AGAIN" }, parentId: 2, seqId: 3, branchId: "main", timestamp: 3000 },
			{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 3, seqId: 4, branchId: "main", timestamp: 4000 },
			{ type: "state_action", kind: "complete", actionUid, event: { type: "AGAIN" }, parentId: 4, seqId: 5, branchId: "main", timestamp: 5000 },
			{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 5, seqId: 6, branchId: "main", timestamp: 6000 },
		];
		writeFileSync(join(runDir, "log.jsonl"), [
			{ kind: "branch", op: "create", branchId: "main", headSeqId: null, committedAt: 900 },
			{ kind: "record_batch", branchId: "main", records, headSeqId: 6, committedAt: 6000 },
		].map((mutation) => JSON.stringify(mutation)).join("\n") + "\n");
		const actionDir = join(sessionsDir, branchSessionSegment("main"), actionUidDirName(actionUid));
		const firstFile = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:1`), "first.jsonl");
		// Visits 2 and 3 resume the first session, so their own invocation directories have no transcript.
		const thirdVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:3`));
		mkdirSync(join(firstFile, ".."), { recursive: true });
		mkdirSync(thirdVisitDir, { recursive: true });
		writeFileSync(firstFile, "{}\n");
		// Legacy progress files retain only the latest action session and have no visit field.
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			// A stale row must not suppress recovery from the real visit directory, even when it claims newer activity.
			sessionFile: join(sessionsDir, "missing.jsonl"),
			lastActivityAt: Number.MAX_SAFE_INTEGER,
		});

		const run = await hyperchartRunFromRunDir(runDir, {
			includeTranscripts: true,
			readTranscript: (_sessionsDir, sessionFile) => {
				if (sessionFile === firstFile) return [
					{ id: "first", role: "assistant", text: "first visit", timestamp: 2500 },
					{ id: "boundary", role: "assistant", text: "second visit boundary", timestamp: 4000 },
					{ id: "resumed", role: "assistant", text: "resumed visit", timestamp: 4500 },
					{ id: "third", role: "assistant", text: "third visit", timestamp: 6500 },
				];
				return undefined;
			},
		});
		const state = run.states.find((state) => state.id === "work");
		const visits = state?.visitHistory;
		expect(visits?.[0]?.session?.messages).toEqual([
			{ id: "first", role: "assistant", text: "first visit", timestamp: 2500 },
		]);
		expect(visits?.[1]?.session?.messages).toEqual([
			{ id: "boundary", role: "assistant", text: "second visit boundary", timestamp: 4000 },
			{ id: "resumed", role: "assistant", text: "resumed visit", timestamp: 4500 },
		]);
		expect(visits?.[2]?.session?.messages).toEqual([
			{ id: "third", role: "assistant", text: "third visit", timestamp: 6500 },
		]);
		expect(state?.session?.messages).toEqual([
			{ id: "third", role: "assistant", text: "third visit", timestamp: 6500 },
		]);
	});

	it("uses the run's persisted role and toolset mappings for resolved agent configuration", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-run-config-"));
		roots.push(root);
		const chartPath = join(root, "configured.chart.ts");
		writeFileSync(
			chartPath,
			`import { agent, chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "configured", initial: "work", states: {
  work: { kind: "state", action: agent("worker", { task: "work" }), transitions: { DONE: "done" } },
  done: final(),
} });
`,
		);
		const runDir = join(root, "run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: root, chartId: "configured", createdAt: new Date().toISOString() });
		writeFileSync(
			join(runDir, "runner.config.json"),
			JSON.stringify({
				runId: "configured-run",
				branchId: "main",
				runDir,
				chartPath,
				chartId: "configured",
				workDir: root,
				defaultModel: "openai/default",
				modelRoles: { worker: "deepseek/worker" },
				toolsets: { researching: ["read", "browser"] },
			}),
		);
		const actionUid = { chart: "configured", state: "work", action: "agent" };
		updateSessionProgress(join(runDir, "sessions"), actionUid, {
			actionName: "worker",
			status: "running",
			role: "worker",
			model: "deepseek/worker",
			toolset: "researching",
			tools: ["read", "browser", "finish"],
		});

		const run = await hyperchartRunFromRunDir(runDir, {
			agentDefaults: () => ({
				role: "worker",
				model: "anthropic/fallback",
				resolvedModel: "stale/current-setting",
				toolset: "researching",
				tools: ["bash"],
				resolvedTools: ["stale-tool", "finish"],
			}),
		});
		const state = run.states.find((candidate) => candidate.id === "work");

		expect(state).toMatchObject({
			role: "worker",
			model: "anthropic/fallback",
			resolvedModel: "deepseek/worker",
			toolset: "researching",
			tools: ["bash"],
			resolvedTools: ["read", "browser", "finish"],
			session: {
				role: "worker",
				model: "deepseek/worker",
				toolset: "researching",
				tools: ["read", "browser", "finish"],
			},
		});

		writeFileSync(join(runDir, "runner.config.json"), "{ invalid json");
		const invalidSnapshot = await hyperchartRunFromRunDir(runDir, {
			agentDefaults: () => ({
				role: "worker",
				model: "anthropic/fallback",
				resolvedModel: "mutable/current-setting",
				toolset: "researching",
				tools: ["bash"],
				resolvedTools: ["mutable-tool", "finish"],
			}),
		});
		const invalidState = invalidSnapshot.states.find((candidate) => candidate.id === "work");
		expect(invalidState).toMatchObject({
			role: "worker",
			model: "anthropic/fallback",
			toolset: "researching",
			tools: ["bash"],
		});
		expect(invalidState?.resolvedModel).toBeUndefined();
		expect(invalidState?.resolvedTools).toBeUndefined();
	});

	it("handles explicit transcript limits without treating zero as unlimited", () => {
		const messages = [
			{ id: "1", role: "user" as const, text: "first" },
			{ id: "2", role: "assistant" as const, text: "second" },
		];
		expect(limitTranscriptMessages(messages, { limit: 0 })).toEqual([]);
		expect(limitTranscriptMessages(messages, { limit: 1 })).toEqual([messages[1]]);
		expect(() => limitTranscriptMessages(messages, { limit: Number.POSITIVE_INFINITY })).toThrow(RangeError);
		expect(() => limitTranscriptMessages(messages, { limit: -1 })).toThrow(RangeError);
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
