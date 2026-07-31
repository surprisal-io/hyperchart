import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import register from "../packages/pi-hyperchart/extensions/hyperchart.js";
import { HYPERCHART_COMMAND_EVENT, requestHyperchartCommand, type HyperchartCommandRequest } from "../packages/pi-hyperchart/src/command.js";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../packages/hyperchart/src/core/action_uid.js";
import { loadRunMeta, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
	removeTerminalNotificationOutbox,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import {
	closeUserInteraction,
	hasUserInteractionReceipt,
	persistUserInteractionRequest,
	readUserInteractionResponse,
} from "../packages/hyperchart/src/runtime/generic/user_interactions.js";
import { patchRunStatus, readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { readSessionProgress, updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import {
	closeRunInspectorServer,
	openRunInspector,
} from "../packages/hyperchart/src/inspect/inspector_server.js";
import type { ReplySchemaSummary } from "../packages/hyperchart/src/host/summarize.js";
import { answerFromReplySummary } from "./reply_summary_helpers.js";

type HyperchartCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
};
type HyperchartTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionCommandContext,
	) => Promise<{ details?: unknown }>;
};
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };

let previousAgentDir: string | undefined;
let previousCwd = process.cwd();
let tempDir = "";
let agentDir = "";
let projectDir = "";
let otherProjectDir = "";

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousCwd = process.cwd();
	tempDir = mkdtempSync(join(tmpdir(), "hyperchart-extension-"));
	agentDir = join(tempDir, "agent");
	projectDir = join(tempDir, "project");
	otherProjectDir = join(tempDir, "other-project");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	projectDir = realpathSync(projectDir);
	otherProjectDir = realpathSync(otherProjectDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
});

afterEach(async () => {
	vi.useRealTimers();
	await closeRunInspectorServer();
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("hyperchart extension", () => {
	it("registers one consolidated hyperchart tool", () => {
		expect(registeredToolNames()).toEqual(["hyperchart"]);
	});

	it("records the originating pi session on a new run", async () => {
		const chartPath = join(tempDir, "session-owned.mjs");
		writeFileSync(chartPath, `export default { kind: "chart", id: "owned", initial: "done", states: { done: { kind: "final" } } };\n`);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "run", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const details = result.details as { runDir: string; inspector?: unknown; notification?: unknown };
		const runDir = details.runDir;

		expect(details.inspector).toBeUndefined();
		expect(details.notification).toBeUndefined();
		expect(loadRunMeta(runDir).originSessionId).toBe("session-a");
	});

	it("returns only bounded startup coordinates for wait=false and rejects verbose static inspection", async () => {
		const chartPath = join(tempDir, "bounded-start.mjs");
		writeFileSync(chartPath, `export default { kind: "chart", id: "bounded-start", initial: "done", states: { done: { kind: "final" } } };\n`);
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const started = await tool.execute(
			"start-bounded",
			{ action: "run", chartPath, wait: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = started.details as Record<string, unknown> & { runDir: string };
		expect(details).toMatchObject({ chartId: "bounded-start", runId: expect.any(String), runDir: expect.stringMatching(/^\//), final: false });
		expect(details).not.toHaveProperty("inspector");
		expect(details).not.toHaveProperty("states");
		await tool.execute("finish-bounded", { action: "run", runDir: details.runDir, wait: true }, new AbortController().signal, () => undefined, ctx);
		await expect(tool.execute(
			"verbose-static",
			{ action: "inspect", chartPath, verbose: true },
			new AbortController().signal,
			() => undefined,
			ctx,
		)).rejects.toThrow(/hyperchart view/);
	}, 30_000);

	it("passes merged model roles and toolsets from settings into the runner config", async () => {
		mkdirSync(join(agentDir, "hypercharts"), { recursive: true });
		writeFileSync(
			join(agentDir, "hypercharts", "settings.json"),
			JSON.stringify({
				roles: { reviewer: "user/model", scout: "user/scout" },
				toolsets: { reading: ["read", "grep"] },
			}),
		);
		mkdirSync(join(projectDir, ".pi", "hypercharts"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "hypercharts", "settings.json"),
			JSON.stringify({ roles: { reviewer: "project/model" }, toolsets: { reading: ["read"] } }),
		);
		const chartPath = join(tempDir, "roles-config.mjs");
		writeFileSync(chartPath, `export default { kind: "chart", id: "roles", initial: "done", states: { done: { kind: "final" } } };\n`);

		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "run", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const runDir = (result.details as { runDir: string }).runDir;
		const config = JSON.parse(readFileSync(join(runDir, "runner.config.json"), "utf8"));

		expect(config.modelRoles).toEqual({ reviewer: "project/model", scout: "user/scout" });
		expect(config.toolsets).toEqual({ reading: ["read"] });
		expect(config.piModules.codingAgent.startsWith(getPackageDir())).toBe(true);
		expect(existsSync(config.piModules.codingAgent)).toBe(true);
		expect(existsSync(config.piModules.typebox)).toBe(true);
	});

	it("restores widgets only for non-terminal runs owned by the current pi session", async () => {
		const chartPath = writeChart("session-restore");
		createRun("owned-running", projectDir, chartPath, "session-a");
		createRun("foreign-session", projectDir, chartPath, "session-b");
		createRun("legacy-unowned", projectDir, chartPath);
		createRun("foreign-project", otherProjectDir, chartPath, "session-a");
		const failedRunDir = createRun("owned-failed", projectDir, chartPath, "session-a");
		patchRunStatus(failedRunDir, { runId: "owned-failed", chartId: "demo", state: "failed", exitCode: 1 });
		const completedRunDir = createRun("owned-complete", projectDir, chartPath, "session-a");
		patchRunStatus(completedRunDir, { runId: "owned-complete", chartId: "demo", state: "complete", exitCode: 0 });

		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const { ctx, widgetKeys } = commandContext(projectDir);

		await sessionStart?.({ reason: "startup" }, ctx);

		expect(widgetKeys).toEqual(["hyperchart:owned-running"]);
	});

	it("recovers terminal notifications only into the exact owning session and workDir", async () => {
		const chartPath = writeChart("terminal-routing");
		const owned = createRun("owned-terminal", projectDir, chartPath, "session-a");
		const foreignSession = createRun("foreign-terminal", projectDir, chartPath, "session-b");
		const foreignWorkDir = createRun("foreign-workdir-terminal", otherProjectDir, chartPath, "session-a");
		for (const runDir of [owned, foreignSession, foreignWorkDir]) {
			persistTerminalNotificationRequest(runDir, {
				runId: runDir.split("/").at(-1)!,
				runDir,
				chartId: "demo",
				outcome: "complete",
				prompt: `terminal ${runDir}`,
				artifacts: [],
			});
			patchRunStatus(runDir, { runId: runDir.split("/").at(-1)!, chartId: "demo", state: "complete" });
		}
		// Created last so it is scanned first: its malformed outbox must not prevent the
		// valid owned run from being recovered.
		const malformed = createRun("malformed-terminal", projectDir, chartPath, "session-a");
		mkdirSync(join(malformed, "terminal-notification"), { recursive: true });
		writeFileSync(join(malformed, "terminal-notification", "request.json"), "{not-json\n");
		patchRunStatus(malformed, { runId: "malformed-terminal", chartId: "demo", state: "complete" });
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const sent: Array<{ customType: string; details: { requestId: string } }> = [];
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			sendMessage: (message: { customType: string; details: { requestId: string } }) => sent.push(message),
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & { sessionManager: { getEntries(): unknown[] } };
		context.sessionManager.getEntries = () => [];

		await sessionStart?.({ reason: "startup" }, context);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("hyperchart-terminal");
		expect(hasTerminalNotificationReceipt(owned, "pi", "session-a")).toBe(true);
		expect(hasTerminalNotificationReceipt(foreignSession, "pi", "session-a")).toBe(false);
		expect(hasTerminalNotificationReceipt(foreignWorkDir, "pi", "session-a")).toBe(false);
	});

	it("confirms only after Pi accepts the message and retries a pre-delivery failure", async () => {
		const chartPath = writeChart("terminal-send-order");
		const runDir = createRun("terminal-send-order", projectDir, chartPath, "session-a");
		persistTerminalNotificationRequest(runDir, {
			runId: "terminal-send-order", runDir, chartId: "demo", outcome: "complete", prompt: "done", artifacts: [],
		});
		patchRunStatus(runDir, { runId: "terminal-send-order", chartId: "demo", state: "complete" });
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let attempts = 0;
		const pi = {
			registerCommand: () => {}, registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			sendMessage: () => {
				attempts++;
				expect(hasTerminalNotificationReceipt(runDir, "pi", "session-a")).toBe(false);
				if (attempts === 1) throw new Error("send failed");
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & { sessionManager: { getEntries(): unknown[] } };
		context.sessionManager.getEntries = () => [];

		await sessionStart?.({ reason: "startup" }, context);
		expect(attempts).toBe(1);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session-a")).toBe(false);
		await sessionStart?.({ reason: "resume" }, context);
		expect(attempts).toBe(2);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session-a")).toBe(true);
	});

	it("does not resend a terminal request already persisted in the Pi session", async () => {
		const chartPath = writeChart("terminal-persisted");
		const runDir = createRun("persisted-terminal", projectDir, chartPath, "session-a");
		const request = persistTerminalNotificationRequest(runDir, {
			runId: "persisted-terminal",
			runDir,
			chartId: "demo",
			outcome: "failed",
			prompt: "failed terminal",
			artifacts: [],
			error: "boom",
		});
		patchRunStatus(runDir, { runId: "persisted-terminal", chartId: "demo", state: "failed", error: "boom" });
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let sends = 0;
		const pi = {
			registerCommand: () => {}, registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			sendMessage: () => { sends++; },
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & { sessionManager: { getEntries(): unknown[] } };
		context.sessionManager.getEntries = () => [{
			type: "custom_message",
			id: "entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "hyperchart-terminal",
			content: "failed terminal",
			display: true,
			details: { requestId: request.requestId },
		}];

		await sessionStart?.({ reason: "resume" }, context);

		expect(sends).toBe(0);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session-a")).toBe(true);
	});

	it("delivers an identical post-rewind notification because it has a new request identity", async () => {
		const chartPath = writeChart("terminal-rewind-generation");
		const runDir = createRun("terminal-rewind-generation", projectDir, chartPath, "session-a");
		const payload = {
			runId: "terminal-rewind-generation",
			runDir,
			chartId: "demo",
			outcome: "complete" as const,
			prompt: "identical terminal",
			artifacts: [],
		};
		const oldRequest = persistTerminalNotificationRequest(runDir, payload);
		removeTerminalNotificationOutbox(runDir);
		const newRequest = persistTerminalNotificationRequest(runDir, payload);
		patchRunStatus(runDir, { runId: payload.runId, chartId: "demo", state: "complete" });
		expect(newRequest.requestId).not.toBe(oldRequest.requestId);
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const sent: Array<{ details: { requestId: string } }> = [];
		const pi = {
			registerCommand: () => {}, registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			sendMessage: (message: { details: { requestId: string } }) => sent.push(message),
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & { sessionManager: { getEntries(): unknown[] } };
		context.sessionManager.getEntries = () => [{
			type: "custom_message",
			id: "old-terminal",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "hyperchart-terminal",
			content: "identical terminal",
			display: true,
			details: { requestId: oldRequest.requestId },
		}];

		await sessionStart?.({ reason: "resume" }, context);
		expect(sent.map((message) => message.details.requestId)).toEqual([newRequest.requestId]);
	});

	it("steers once while busy, then presents the same gate once after settling", async () => {
		vi.useFakeTimers();
		const runDir = createUserGate("busy-gate", 4);
		const harness = lifecycleHarness(projectDir, false);
		try {
			await harness.sessionStart();
			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]).toMatchObject({
				message: {
					customType: "hyperchart-yield",
					display: false,
					details: { runId: "busy-gate", seqId: 4 },
				},
				options: { deliverAs: "steer" },
			});
			expect(harness.sent[0]?.options).not.toHaveProperty("triggerTurn");
			await vi.advanceTimersByTimeAsync(3_000);
			expect(harness.sent).toHaveLength(1);

			harness.setIdle(true);
			await harness.agentSettled();
			expect(harness.sent).toHaveLength(2);
			expect(harness.sent[1]).toMatchObject({
				message: {
					customType: "hyperchart-user-request",
					display: true,
					details: { runId: "busy-gate", seqId: 4 },
				},
				options: { deliverAs: "followUp" },
			});
			expect(harness.sent[1]?.options).not.toHaveProperty("triggerTurn");
			expect(hasUserInteractionReceipt(runDir, 4, "pi", "session-a")).toBe(true);
			await vi.advanceTimersByTimeAsync(3_000);
			expect(harness.sent).toHaveLength(2);
		} finally {
			await harness.shutdown();
		}
	});

	it("recovers a persisted visible gate without resending and binds the next real prompt", async () => {
		const runDir = createUserGate("recovered-gate", 2);
		const harness = lifecycleHarness(projectDir, true);
		harness.setEntries([{
			type: "custom_message",
			customType: "hyperchart-user-request",
			content: "persisted",
			display: true,
			details: { runId: "recovered-gate", seqId: 2 },
		}]);
		try {
			await harness.sessionStart("resume");
			expect(harness.sent).toHaveLength(0);
			expect(hasUserInteractionReceipt(runDir, 2, "pi", "session-a")).toBe(true);

			const injected = await harness.beforeAgentStart("Yes, approve it with a short note");
			expect(injected).toMatchObject({
				message: {
					customType: "hyperchart-user-response-context",
					display: false,
					details: { runId: "recovered-gate", seqId: 2 },
				},
			});
			expect(JSON.stringify(injected)).toContain("just-submitted prompt");
			expect(JSON.stringify(injected)).toContain('action=\\"respond\\"');
		} finally {
			await harness.shutdown();
		}
	});

	it("does not let a pre-rewind session message acknowledge a recreated coordinate", async () => {
		const runDir = createUserGate("rewound-gate", 1);
		const harness = lifecycleHarness(projectDir, true);
		harness.setEntries([{
			type: "custom_message",
			timestamp: "1970-01-01T00:00:00.000Z",
			customType: "hyperchart-user-request",
			content: "old presentation",
			display: true,
			details: { runId: "rewound-gate", seqId: 1 },
		}]);
		try {
			await harness.sessionStart("resume");
			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]?.message.details).toMatchObject({ runId: "rewound-gate", seqId: 1 });
			expect(hasUserInteractionReceipt(runDir, 1, "pi", "session-a")).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	it("serializes owned gates and promotes only after an explicit validated response", async () => {
		const runB = createUserGate("run-b", 1);
		const runA2 = createUserGate("run-a", 2);
		persistUserInteractionRequest(runA2, {
			runId: "run-a",
			seqId: 1,
			actionUid: { chart: "demo", state: "ask-first", action: "user" },
			prompt: "First question?",
			options: ["APPROVED"],
			events: ["APPROVED", "FAILED"],
		});
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			expect(harness.sent.map(({ message }) => {
				const details = message.details as { runId: string; seqId: number };
				return { runId: details.runId, seqId: details.seqId };
			})).toEqual([{ runId: "run-a", seqId: 1 }]);

			const first = await harness.tool.execute(
				"respond-1",
				{ action: "respond", runId: "run-a", seqId: 1, event: "APPROVED" },
				new AbortController().signal,
				() => undefined,
				harness.ctx,
			);
			expect(first.details).toMatchObject({ committed: true, idempotent: false, runId: "run-a", seqId: 1 });
			expect(readUserInteractionResponse(runA2, 1)?.event).toEqual({ type: "APPROVED" });
			expect(harness.sent.at(-1)?.message.details).toMatchObject({ runId: "run-a", seqId: 2 });

			const identical = await harness.tool.execute(
				"respond-retry",
				{ action: "respond", runId: "run-a", seqId: 1, event: "APPROVED" },
				new AbortController().signal,
				() => undefined,
				harness.ctx,
			);
			expect(identical.details).toMatchObject({ committed: true, idempotent: true });
			await expect(harness.tool.execute(
				"respond-conflict",
				{ action: "respond", runId: "run-a", seqId: 1, event: "REJECTED" },
				new AbortController().signal,
				() => undefined,
				harness.ctx,
			)).rejects.toThrow(/Conflicting response/);
			expect(readUserInteractionResponse(runB, 1)).toBeUndefined();
		} finally {
			await harness.shutdown();
		}
	});

	it("isolates foreign, closed, and malformed gates while inspecting active versus queued", async () => {
		const activeDir = createUserGate("owned-a", 1);
		createUserGate("owned-b", 1);
		createUserGate("foreign-session-gate", 1, { sessionId: "session-b" });
		createUserGate("foreign-workdir-gate", 1, { workDir: otherProjectDir });
		const closedDir = createUserGate("closed-gate", 1);
		closeUserInteraction(closedDir, { runId: "closed-gate", seqId: 1 }, "test");
		const malformedDir = createRun("malformed-gate", projectDir, writeUserChart("malformed-gate"), "session-a");
		patchRunStatus(malformedDir, {
			runId: "malformed-gate", chartId: "demo", state: "running", pid: process.pid, heartbeatAt: Date.now(),
		});
		mkdirSync(join(malformedDir, "user-interactions", "1"), { recursive: true });
		writeFileSync(join(malformedDir, "user-interactions", "1", "request.json"), "{broken\n");
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]?.message.details).toMatchObject({ runId: "owned-a", seqId: 1 });
			expect(hasUserInteractionReceipt(activeDir, 1, "pi", "session-a")).toBe(true);

			const inspected = await harness.tool.execute(
				"inspect-gates",
				{ action: "run_inspect", runDir: "owned-a" },
				new AbortController().signal,
				() => undefined,
				harness.ctx,
			);
			expect(inspected.details).toMatchObject({
				userInteractions: {
					active: { runId: "owned-a", seqId: 1, presentation: "confirmed" },
					queued: [expect.objectContaining({ runId: "owned-b", seqId: 1 })],
				},
			});
		} finally {
			await harness.shutdown();
		}
	});

	it("rejects foreign, stale, reserved, unsupported, and schema-invalid responses", async () => {
		const schema = {
			type: "object",
			properties: { note: { type: "string" } },
			required: ["note"],
			additionalProperties: false,
		};
		const runDir = createUserGate("validated-gate", 1, { events: ["APPROVED", "FAILED"], reply: schema });
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			for (const [event, output, pattern] of [
				["FAILED", undefined, /FAILED is reserved/],
				["OTHER", undefined, /not allowed/],
				["APPROVED", { wrong: true }, /reply schema/],
			] as const) {
				await expect(harness.tool.execute(
					"respond-invalid",
					{ action: "respond", runId: "validated-gate", seqId: 1, event, ...(output === undefined ? {} : { output }) },
					new AbortController().signal,
					() => undefined,
					harness.ctx,
				)).rejects.toThrow(pattern);
			}
			closeUserInteraction(runDir, { runId: "validated-gate", seqId: 1 }, "test");
			await expect(harness.tool.execute(
				"respond-stale",
				{ action: "respond", runId: "validated-gate", seqId: 1, event: "APPROVED", output: { note: "yes" } },
				new AbortController().signal,
				() => undefined,
				harness.ctx,
			)).rejects.toThrow(/stale or closed/);
		} finally {
			await harness.shutdown();
		}

		const foreign = createUserGate("foreign-gate", 1, { sessionId: "session-b" });
		const foreignWorkDir = createUserGate("foreign-workdir-response", 1, { workDir: otherProjectDir });
		const foreignHarness = lifecycleHarness(projectDir, true);
		try {
			await expect(foreignHarness.tool.execute(
				"respond-foreign",
				{ action: "respond", runId: "foreign-gate", seqId: 1, event: "APPROVED" },
				new AbortController().signal,
				() => undefined,
				foreignHarness.ctx,
			)).rejects.toThrow(/not owned/);
			await expect(foreignHarness.tool.execute(
				"respond-foreign-cwd",
				{ action: "respond", runId: "foreign-workdir-response", seqId: 1, event: "APPROVED" },
				new AbortController().signal,
				() => undefined,
				foreignHarness.ctx,
			)).rejects.toThrow(/another working directory/);
			expect(readUserInteractionResponse(foreign, 1)).toBeUndefined();
			expect(readUserInteractionResponse(foreignWorkDir, 1)).toBeUndefined();
		} finally {
			await foreignHarness.shutdown();
		}
	});

	it("delivers a bounded structured gate summary that is sufficient for a valid response", async () => {
		const runDir = createUserGate("structured-summary", 1, {
			events: ["APPROVED", "FAILED"],
			reply: complexGateSchema(),
		});
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			const details = harness.sent[0]?.message.details as {
				runId: string; seqId: number; allowedEvents: string[]; outputRequired: boolean; outputHint?: ReplySchemaSummary;
			};
			expect(details).toMatchObject({
				runId: "structured-summary", seqId: 1, allowedEvents: ["APPROVED"], outputRequired: true,
				outputHint: { types: ["object"], fields: expect.arrayContaining([
					expect.objectContaining({ name: "decision", value: expect.objectContaining({ allowedValueJson: ['"approve"', '"reject"'] }) }),
					expect.objectContaining({ name: "review", value: expect.objectContaining({ fields: expect.any(Array) }) }),
					expect.objectContaining({ name: "findings", value: expect.objectContaining({ element: expect.any(Object) }) }),
				]) },
			});
			expect(details).not.toHaveProperty("reply");
			expect(details).not.toHaveProperty("schema");
			const output = answerFromReplySummary(details.outputHint!);
			await harness.tool.execute("respond-summary", {
				action: "respond", runId: details.runId, seqId: details.seqId, event: details.allowedEvents[0], output,
			}, new AbortController().signal, () => undefined, harness.ctx);
			expect(readUserInteractionResponse(runDir, 1)?.event).toEqual({ type: "APPROVED", output });
		} finally {
			await harness.shutdown();
		}
	});

	it("round-trips long gate identities through Pi lifecycle delivery and respond", async () => {
		const runId = `long-${"r".repeat(180)}`;
		const event = `APPROVED_${"e".repeat(180)}`;
		const option = `Choice ${"o".repeat(180)}`;
		const runDir = createUserGate(runId, 1, {
			events: [event, "FAILED"],
			gateOptions: [option],
			reply: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
		});
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			const message = harness.sent[0]?.message;
			expect(message).toMatchObject({ customType: "hyperchart-user-request" });
			const details = message?.details as {
				runId: string;
				seqId: number;
				allowedEvents: string[];
				options: Array<{ label: { text: string; originalChars: number; omittedChars: number }; value: string }>;
			};
			expect(details.runId).toBe(runId);
			expect(details.allowedEvents).toEqual([event]);
			expect(details.options).toEqual([{
				label: { text: `${option.slice(0, 159)}…`, originalChars: option.length, omittedChars: option.length - 159 },
				value: option,
			}]);
			expect(JSON.stringify(details)).not.toContain(`${runId.slice(0, 159)}…`);
			expect(JSON.stringify(details)).not.toContain(`${event.slice(0, 159)}…`);

			const output = { note: details.options[0]!.value };
			const response = await harness.tool.execute("respond-long-identities", {
				action: "respond",
				runId: details.runId,
				seqId: details.seqId,
				event: details.allowedEvents[0],
				output,
			}, new AbortController().signal, () => undefined, harness.ctx);
			expect(response.details).toMatchObject({ committed: true, runId, seqId: 1, event });
			expect(readUserInteractionResponse(runDir, 1)).toMatchObject({
				runId,
				seqId: 1,
				event: { type: event, output: { note: option } },
			});
		} finally {
			await harness.shutdown();
		}
	});

	it("fails closed through Pi delivery for an oversized gate identity", async () => {
		createUserGate("unsafe-identity", 1, { events: ["e".repeat(2_001)] });
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			expect(harness.sent[0]?.message).toMatchObject({
				customType: "hyperchart-boundary-error",
				details: { error: "user-gate-summary-unavailable" },
			});
			expect(harness.sent[0]?.message.content).toMatch(/identity.*cannot be truncated.*browser inspector/i);
			expect(harness.sent[0]?.message.content).not.toContain("…");
		} finally {
			await harness.shutdown();
		}
	});

	it("bounds overflow through the actual Pi tool handler", async () => {
		for (let index = 0; index < 21; index++) createUserGate(`tool-overflow-${String(index).padStart(2, "0")}`, 1, { reply: largeRepresentableGateSchema() });
		const harness = lifecycleHarness(projectDir, true);
		try {
			const result = await harness.tool.execute("overflow", { action: "run_inspect", runDir: "tool-overflow-00" }, new AbortController().signal, () => undefined, harness.ctx);
			expect(result.details).toMatchObject({ error: "model-envelope-too-large", digest: expect.stringMatching(/^fnv1a32:/), maxBytes: 64 * 1024 });
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
		} finally {
			await harness.shutdown();
		}
	});

	it("bounds overflow through the actual Pi custom-message handler", async () => {
		const chartPath = writeChart("message-overflow");
		const runDir = createRun("message-overflow", projectDir, chartPath, "session-a");
		patchRunStatus(runDir, { runId: "message-overflow", chartId: "demo", state: "complete" });
		persistTerminalNotificationRequest(runDir, {
			runId: "x".repeat(100_000), runDir, chartId: "demo", outcome: "complete", prompt: "done", artifacts: [],
		});
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			const message = harness.sent[0]?.message;
			expect(message).toMatchObject({ customType: "hyperchart-boundary-error", details: { error: "model-envelope-too-large" } });
			expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64 * 1024);
		} finally {
			await harness.shutdown();
		}
	});

	it("fails closed through Pi delivery when a gate contract cannot be summarized", async () => {
		createUserGate("unrepresentable-summary", 1, { reply: { type: "string", enum: Array.from({ length: 41 }, (_, index) => `value-${index}`) } });
		const harness = lifecycleHarness(projectDir, true);
		try {
			await harness.sessionStart();
			expect(harness.sent[0]?.message).toMatchObject({ customType: "hyperchart-boundary-error", details: { error: "user-gate-summary-unavailable" } });
			expect(harness.sent[0]?.message.content).toMatch(/browser inspector/i);
		} finally {
			await harness.shutdown();
		}
	});

	it("returns a shared user boundary from wait=true and commits respond without hanging", async () => {
		const chartPath = writeUserChart("waited-user-gate");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);
		const waited = await tool.execute(
			"waited-run",
			{ action: "run", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const boundary = waited.details as {
			boundary: string;
			final: boolean;
			runId: string;
			runDir: string;
			interaction: { runId: string; seqId: number };
		};
		expect(boundary).toMatchObject({
			boundary: "user",
			final: false,
			interaction: { runId: boundary.runId },
		});
		// The waited result pins but does not confirm presentation before the tool result
		// is durably delivered; the settled scanner confirms the visible request later.
		expect(hasUserInteractionReceipt(boundary.runDir, boundary.interaction.seqId, "pi", "session-a")).toBe(false);

		await tool.execute(
			"waited-response",
			{
				action: "respond",
				runId: boundary.runId,
				seqId: boundary.interaction.seqId,
				event: "APPROVED",
			},
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(readUserInteractionResponse(boundary.runDir, boundary.interaction.seqId)?.event).toEqual({ type: "APPROVED" });
		await tool.execute(
			"stop-waited-run",
			{ action: "stop", runDir: boundary.runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
	});

	it("lists project and user charts with project precedence", async () => {
		const projectCharts = join(projectDir, ".pi", "hypercharts");
		const userCharts = join(agentDir, "hypercharts");
		mkdirSync(projectCharts, { recursive: true });
		mkdirSync(userCharts, { recursive: true });
		writeFileSync(join(userCharts, "shared.chart.ts"), "export default {};\n");
		writeFileSync(join(userCharts, "user-only.chart.ts"), "export default {};\n");
		writeFileSync(join(projectCharts, "shared.chart.ts"), "export default {};\n");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "list" }, new AbortController().signal, () => undefined, ctx);
		const charts = (result.details as { charts: Array<{ name: string; scope: string }> }).charts;
		const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;

		expect(text).toBe([
			"Found 2 Hyperchart definitions:",
			"- shared [project]",
			"- user-only [user]",
		].join("\n"));
		expect(charts).toEqual([
			expect.objectContaining({ name: "shared", scope: "project" }),
			expect.objectContaining({ name: "user-only", scope: "user" }),
		]);
	});

	it("lists a user chart bundle installed as a directory symlink", async () => {
		const userCharts = join(agentDir, "hypercharts");
		const externalBundle = join(tempDir, "odyssey-source");
		mkdirSync(userCharts, { recursive: true });
		mkdirSync(externalBundle, { recursive: true });
		writeFileSync(join(externalBundle, "chart.ts"), "export default {};\n");
		symlinkSync(externalBundle, join(userCharts, "odyssey"), "dir");

		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const charts = (result.details as { charts: Array<{ name: string; path: string }> }).charts;
		expect(charts).toEqual([expect.objectContaining({ name: "odyssey", path: join(userCharts, "odyssey", "chart.ts") })]);
	});

	it("registers tools from a self-contained chart bundle extension without listing its implementation files", async () => {
		const bundleDir = join(projectDir, ".pi", "hypercharts", "bundled");
		mkdirSync(join(bundleDir, "extensions", "custom"), { recursive: true });
		writeFileSync(join(bundleDir, "chart.ts"), "export default {};\n");
		writeFileSync(join(bundleDir, "extensions", "custom", "index.ts"), [
			"export default function register(pi: any) {",
			"  pi.registerTool({ name: 'bundle_tool', parameters: {}, execute() {} });",
			"}",
		].join("\n"));

		expect(registeredToolNames()).toEqual(["bundle_tool", "hyperchart"]);
		const list = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const charts = (list.details as { charts: Array<{ name: string }> }).charts;
		expect(charts.map((chart) => chart.name)).toEqual(["bundled"]);
	});

	it("stops one run through the consolidated tool", async () => {
		const chartPath = writeChart("stoppable");
		const runDir = createRun("stoppable-run", projectDir, chartPath);
		patchRunStatus(runDir, {
			runId: "stoppable-run",
			chartId: "demo",
			state: "running",
			pid: 999_999_999,
			heartbeatAt: Date.now(),
		});
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "stop", runDir: "stoppable-run" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);

		expect(readRunStatus(runDir)).toMatchObject({ state: "stopped", exitCode: 0 });
		expect((result as { content: Array<{ text: string }> }).content[0]?.text).toContain("stoppable-run (marked stopped)");
	});

	it("accepts commands from another pi extension over the shared event bus", async () => {
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let commandRequest: ((request: HyperchartCommandRequest) => void) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			events: {
				on: (event: string, handler: (request: HyperchartCommandRequest) => void) => {
					if (event === HYPERCHART_COMMAND_EVENT) commandRequest = handler;
				},
				emit: () => {},
			},
		} as unknown as ExtensionAPI;
		register(pi);
		const { ctx, notifications } = commandContext(projectDir);
		await sessionStart?.({ reason: "startup" }, ctx);

		const handled = await requestHyperchartCommand({
			emit(event, payload) {
				if (event === HYPERCHART_COMMAND_EVENT) commandRequest?.(payload as HyperchartCommandRequest);
			},
		}, "status");

		expect(handled).toBe(true);
		expect(notifications).toContainEqual({ message: "No hyperchart runs", type: "info" });
		await expect(requestHyperchartCommand({
			emit(event, payload) {
				if (event === HYPERCHART_COMMAND_EVENT) commandRequest?.(payload as HyperchartCommandRequest);
			},
		}, "resume")).rejects.toThrow("resume requires a runId");
	});

	it("closes the browser inspector server on session shutdown", async () => {
		let sessionShutdown: (() => Promise<void>) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") sessionShutdown = handler;
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const { url } = await openRunInspector({
			runId: "lifecycle-run",
			loadRun: async () => ({ runId: "lifecycle-run" }) as never,
			openBrowser: () => undefined,
		});
		expect((await fetch(url)).status).toBe(200);

		await sessionShutdown?.();

		await expect(fetch(url)).rejects.toThrow();
	});

	it("queues steering for a live agent session", async () => {
		const runId = "steerable-run";
		const runDir = createRun(runId, projectDir, writeChart("steerable"));
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		const actionKey = `${actionUid.chart}:${actionUid.state}:${actionUid.action}`;
		updateSessionProgress(join(runDir, "sessions"), actionUid, {
			actionName: "worker",
			status: "running",
		});
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler(`steer '${runId}' '${actionKey}' 'Prioritize the narrow layout'`, ctx);

		const files = readdirSync(join(runDir, "sessions", "steering"));
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", files[0]!), "utf8"))).toMatchObject({
			actionKey,
			message: "Prioritize the narrow layout",
		});
		expect(notifications).toContainEqual({ message: "Steering queued for @worker", type: "info" });
	});

	it("offers documented top-level commands and run ids with an empty prefix", () => {
		const runId = "demo-run";
		createRun(runId, projectDir, writeChart("demo"));

		const values = registeredCommand()
			.getArgumentCompletions("")
			?.map((item) => item.value);

		expect(values).toContain("view");
		expect(values).toContain("steer");
		expect(values).toContain(runId);
	});

	it("enriches inspected agents with defaults from subagent definitions", async () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "worker.md"),
			"---\ndescription: Reviews implementation details\nmodel: anthropic/claude-sonnet\nthinking: high\ntools:\n  - read\n  - grep\n---\nWorker prompt\n",
			"utf8",
		);
		const chartPath = writeChart("inspect-defaults");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "inspect", chartPath }, new AbortController().signal, () => undefined, ctx);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			description: "Reviews implementation details",
			model: "anthropic/claude-sonnet",
			thinking: "high",
			tools: ["read", "grep"],
		});
	});

	it("loads agent descriptions from the selected chart bundle", async () => {
		const bundleDir = join(agentDir, "hypercharts", "described-bundle");
		mkdirSync(join(bundleDir, "agents"), { recursive: true });
		copyFileSync(writeChart("described-source"), join(bundleDir, "chart.ts"));
		writeFileSync(
			join(bundleDir, "agents", "worker.md"),
			"---\ndescription: Bundle-local analyzer\n---\nAnalyze locally\n",
			"utf8",
		);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "inspect", chartPath: join(bundleDir, "chart.ts") },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			description: "Bundle-local analyzer",
		});
	});

	it("marks unavailable agent definitions in static inspect results", async () => {
		const chartPath = writeChart("inspect-missing-agent");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "inspect", chartPath }, new AbortController().signal, () => undefined, ctx);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			agentDefinitionUnavailable: true,
		});
	});

	it("keeps view as the shortcut for opening the latest run", async () => {
		const runId = "current-run";
		const runDir = createRun(runId, projectDir, writeChart("current"));
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler("view", ctx);

		expect(notifications).toContainEqual({ message: `Run ${runId}: ${runDir}`, type: "info" });
	});

	it("opens the browser inspector with full transcript details through the consolidated agent tool", async () => {
		const runId = "tool-view-run";
		const runDir = createRun(runId, projectDir, writeChart("tool-view"));
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		writeFileSync(join(runDir, "log.jsonl"), [
			{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: 1 },
			{ type: "state_action", kind: "invoke", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" }, parentId: 1, seqId: 2, timestamp: 2 },
		].map((record) => JSON.stringify(record)).join("\n") + "\n");
		const transcriptFile = join(runDir, "sessions", "tool-view.jsonl");
		writeFileSync(transcriptFile, `${JSON.stringify({ id: "assistant-1", type: "message", message: { role: "assistant", content: "inspector transcript" } })}\n`);
		updateSessionProgress(join(runDir, "sessions"), actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: transcriptFile,
		}, "demo:work:agent:1:2");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "view", runDir: runId, open: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = result.details as { url: string };

		expect(details).toEqual({ url: expect.any(String) });
		const inspectorUrl = new URL(details.url);
		expect(inspectorUrl.protocol).toBe("http:");
		expect(inspectorUrl.pathname).toMatch(/^\/runs\/[A-Za-z0-9_-]+$/);
		const response = await fetch(inspectorUrl);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<title>Hyperchart Inspector</title>");

		const token = inspectorUrl.pathname.slice("/runs/".length);
		const runResponse = await fetch(new URL(`/api/runs/${token}`, inspectorUrl));
		expect(runResponse.status).toBe(200);
		const runPayload = (await runResponse.json()) as {
			run: { runId: string; states: Array<{ id: string; session?: { messages?: unknown[] } }> };
		};
		expect(runPayload).toMatchObject({ run: { runId } });
		expect(runPayload.run.states.find((state) => state.id === "work")?.session?.messages).toEqual([
			{ id: "assistant-1", role: "assistant", text: "inspector transcript" },
		]);

		const steerResponse = await fetch(new URL(`/api/runs/${token}/steer`, inspectorUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ actionKey: "work::agent", message: "Focus on primary sources" }),
		});
		expect(steerResponse.status).toBe(202);
		const steeringFiles = readdirSync(join(runDir, "sessions", "steering"));
		expect(steeringFiles).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", steeringFiles[0]!), "utf8"))).toMatchObject({
			actionKey: "work::agent",
			message: "Focus on primary sources",
		});
	});

	it("rejects a foreign-workdir run through the view agent action", async () => {
		const runDir = createRun("foreign-tool-view", otherProjectDir, writeChart("foreign-tool-view"));
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "view", runDir, open: false },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow("belongs to another working directory or is missing metadata");
	});

	it("returns a runtime-enriched inspector model for concrete run dirs", async () => {
		const runId = "runtime-inspect-run";
		const runDir = createRun(runId, projectDir, writeChart("runtime-inspect"));
		const uid = { chart: "demo", state: "work", action: "agent" };
		writeFileSync(
			join(runDir, "log.jsonl"),
			[
				{ type: "args", args: { topic: "wire runtime" }, parentId: null, seqId: 1, timestamp: 1 },
				{ type: "state_action", kind: "invoke", actionUid: uid, definition: { kind: "agent", uid, name: "worker" }, parentId: 1, seqId: 2, timestamp: 2 },
				{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "FAILED", error: { code: 2, stderr: "nope" } }, parentId: 2, seqId: 3, timestamp: 3 },
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
			"utf8",
		);
		patchRunStatus(runDir, { runId, chartId: "demo", state: "failed", exitCode: 1, error: "runner failed", replayWarnings: ["Replay warning: stale provenance"] });
		const transcriptFile = join(runDir, "sessions", "runtime-inspect.jsonl");
		writeFileSync(transcriptFile, `${JSON.stringify({ id: "assistant-1", type: "message", message: { role: "assistant", content: "verbose Pi transcript" } })}\n`);
		updateSessionProgress(join(runDir, "sessions"), uid, {
			actionName: "worker",
			status: "failed",
			error: "session failed",
			lastActivityAt: 4,
			sessionFile: transcriptFile,
		});
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "run_inspect", runDir: runId }, new AbortController().signal, () => undefined, ctx);
		await expect(tool.execute("tool-call-full", { action: "run_inspect", runDir: runId, verbose: true }, new AbortController().signal, () => undefined, ctx)).rejects.toThrow(/hyperchart view/);
		const details = result.details as { mode?: string; args?: Record<string, unknown>; issues?: Array<{ kind: string }>; stateDigests: Array<{ id: string; issues?: Array<{ kind: string; message: string }> }> };

		expect(JSON.stringify(details)).not.toContain("verbose Pi transcript");
		expect(details.mode).toBe("run");
		expect(details.args).toBeUndefined();
		expect(details.issues?.map((issue) => issue.kind)).toEqual(["run_failed", "replay_warning"]);
		expect(details.stateDigests.find((state) => state.id === "work")?.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "action_failed", message: "Script exited with code 2: nope" }),
				expect.objectContaining({ kind: "session_failed", message: "session failed" }),
			]),
		);
	});

	it("does not import path-like or foreign run specs through the top-level fallback", async () => {
		const importedFlag = join(tempDir, "imported.txt");
		const maliciousChart = writeChart("malicious", importedFlag);
		const pathRunDir = join(tempDir, "crafted-run");
		saveRunMeta(pathRunDir, {
			chartPath: maliciousChart,
			workDir: projectDir,
			chartId: "malicious",
			createdAt: new Date().toISOString(),
		});
		createRun("foreign-run", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx } = commandContext(projectDir);

		await command.handler(pathRunDir, ctx);
		await command.handler("foreign-run", ctx);

		expect(existsSync(importedFlag)).toBe(false);
	});

	it("rejects resume of a foreign run before importing its chart", async () => {
		const importedFlag = join(tempDir, "resume-imported.txt");
		const maliciousChart = writeChart("resume-malicious", importedFlag);
		createRun("foreign-resume", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx, notifications } = commandContext(projectDir);

		await command.handler("resume foreign-resume", ctx);

		expect(existsSync(importedFlag)).toBe(false);
		expect(notifications).toContainEqual({
			message: `Run 'foreign-resume' belongs to ${otherProjectDir}; open that directory first`,
			type: "error",
		});
	});

	it("rewinds an incompatible modified-chart run to the compatible prefix", async () => {
		const chartPath = writeIncompatibleReplayChart();
		const runDir = createRun("rewind-compatible", projectDir, chartPath);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "log.jsonl"),
			[
				{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: 1 },
				{
					type: "state_action",
					kind: "invoke",
					actionUid: { chart: "demo", state: "first", action: "agent" },
					definition: { kind: "agent", uid: { chart: "demo", state: "first", action: "agent" }, name: "old-worker" },
					parentId: 1,
					seqId: 2,
					timestamp: 2,
				},
				{
					type: "state_action",
					kind: "complete",
					actionUid: { chart: "demo", state: "first", action: "agent" },
					event: { type: "FIRST_DONE" },
					parentId: 2,
					seqId: 3,
					timestamp: 3,
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
			"utf8",
		);
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "rewind", runDir, to: "compatible", cleanupSessions: true, cleanupArtifacts: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		const lines = readFileSync(join(runDir, "log.jsonl"), "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line) as { seqId: number }).map((record) => record.seqId)).toEqual([1]);
		expect(result.details).toMatchObject({ removedRecords: 2, cutSeqId: 2 });
		expect(existsSync(join(runDir, "rewind-backups"))).toBe(true);
	});

	it("rewind session cleanup preserves retained visits of the same action", async () => {
		const chartPath = join(tempDir, "repeated-visits.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "demo", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { AGAIN: "work", DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		const runDir = createRun("rewind-visits", projectDir, chartPath);
		mkdirSync(runDir, { recursive: true });
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		const definition = { kind: "agent", uid: actionUid, name: "worker" };
		writeFileSync(
			join(runDir, "log.jsonl"),
			[
				{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: 1 },
				{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 1, seqId: 2, timestamp: 2 },
				{ type: "state_action", kind: "complete", actionUid, event: { type: "AGAIN" }, parentId: 2, seqId: 3, timestamp: 3 },
				{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 3, seqId: 4, timestamp: 4 },
				{ type: "state_action", kind: "complete", actionUid, event: { type: "AGAIN" }, parentId: 4, seqId: 5, timestamp: 5 },
				{ type: "state_action", kind: "invoke", actionUid, definition, parentId: 5, seqId: 6, timestamp: 6 },
				{ type: "state_action", kind: "complete", actionUid, event: { type: "DONE" }, parentId: 6, seqId: 7, timestamp: 7 },
			].map((record) => JSON.stringify(record)).join("\n") + "\n",
		);
		const sessionsDir = join(runDir, "sessions");
		const actionDir = join(sessionsDir, actionUidDirName(actionUid));
		const firstVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:1`));
		const secondVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:2`));
		const thirdVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:3`));
		const sharedSessionFile = join(firstVisitDir, "shared.jsonl");
		mkdirSync(firstVisitDir, { recursive: true });
		mkdirSync(secondVisitDir, { recursive: true });
		mkdirSync(thirdVisitDir, { recursive: true });
		writeFileSync(
			sharedSessionFile,
			[
				{ type: "session", id: "shared", timestamp: "1970-01-01T00:00:00.001Z" },
				{ type: "message", timestamp: "1970-01-01T00:00:00.002Z", message: { role: "assistant", content: "retained visit" } },
				{ type: "message", timestamp: "1970-01-01T00:00:00.004Z", message: { role: "assistant", content: "removed visit two" } },
				{ type: "message", timestamp: "1970-01-01T00:00:00.006Z", message: { role: "assistant", content: "removed visit three" } },
			].map((record) => JSON.stringify(record)).join("\n") + "\n",
		);
		writeFileSync(join(secondVisitDir, "visit.marker"), "removed");
		writeFileSync(join(thirdVisitDir, "visit.marker"), "removed");
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{ actionName: "worker", status: "completed", sessionFile: sharedSessionFile },
			"demo:work:agent:1:2",
		);
		// Legacy progress has no visit and represents the latest resumed session, whose transcript spans both removed visits.
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{ actionName: "worker", status: "completed", sessionFile: sharedSessionFile },
		);

		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);
		const result = await tool.execute(
			"tool-call",
			{ action: "rewind", runDir, seqId: 4, mode: "before", cleanupSessions: true, cleanupArtifacts: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		const progress = readSessionProgress(sessionsDir);
		expect(progress.sessions["demo:work:agent:visit:1"]).toBeDefined();
		expect(progress.sessions["demo:work:agent"]).toBeUndefined();
		expect(existsSync(firstVisitDir)).toBe(true);
		expect(existsSync(secondVisitDir)).toBe(false);
		expect(existsSync(thirdVisitDir)).toBe(false);
		expect(readFileSync(sharedSessionFile, "utf8")).toContain("retained visit");
		expect(readFileSync(sharedSessionFile, "utf8")).not.toContain("removed visit two");
		expect(readFileSync(sharedSessionFile, "utf8")).not.toContain("removed visit three");
		expect(result.details).toMatchObject({ cleanup: { sessionsRemoved: 1 } });
	});
});

type LifecycleHarness = {
	ctx: ExtensionCommandContext;
	tool: HyperchartTool;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	setIdle: (idle: boolean) => void;
	setEntries: (entries: unknown[]) => void;
	sessionStart: (reason?: string) => Promise<void>;
	agentSettled: () => Promise<void>;
	beforeAgentStart: (prompt: string) => Promise<unknown>;
	shutdown: () => Promise<void>;
};

function lifecycleHarness(cwd: string, initiallyIdle: boolean): LifecycleHarness {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools: HyperchartTool[] = [];
	const sent: LifecycleHarness["sent"] = [];
	let idle = initiallyIdle;
	let entries: unknown[] = [];
	const base = commandContext(cwd).ctx;
	const ctx = {
		...base,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => "session-a",
			getEntries: () => entries,
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			sent.push({ message, ...(options === undefined ? {} : { options }) });
		},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	const tool = tools.find((candidate) => candidate.name === "hyperchart");
	if (tool === undefined) throw new Error("hyperchart tool was not registered");
	return {
		ctx,
		tool,
		sent,
		setIdle: (value) => { idle = value; },
		setEntries: (value) => { entries = value; },
		sessionStart: async (reason = "startup") => { await handlers.get("session_start")?.({ reason }, ctx); },
		agentSettled: async () => { await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx); },
		beforeAgentStart: async (prompt) => handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, ctx),
		shutdown: async () => { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); },
	};
}

function largeRepresentableGateSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, { type: "string", pattern: "a".repeat(250) }])),
		required: Array.from({ length: 20 }, (_, index) => `field${index}`),
		additionalProperties: false,
	};
}

function complexGateSchema(): Record<string, unknown> {
	return z.toJSONSchema(z.object({
		decision: z.enum(["approve", "reject"]),
		review: z.object({
			note: z.string().min(3).max(12).regex(/^[a-z]+$/),
			priority: z.number().int().min(1).max(5).default(2),
			optionalNote: z.string().optional(),
		}),
		findings: z.array(z.object({
			kind: z.literal("finding"),
			value: z.union([z.literal("ok"), z.number().int().min(1)]),
		})).min(1).max(2),
	}));
}

function createUserGate(
	runId: string,
	seqId: number,
	options: { workDir?: string; sessionId?: string; chartPath?: string; events?: string[]; gateOptions?: string[]; reply?: Record<string, unknown> } = {},
): string {
	const workDir = options.workDir ?? projectDir;
	const chartPath = options.chartPath ?? writeUserChart(`gate-${runId}-${seqId}`);
	const runDir = createRun(runId, workDir, chartPath, options.sessionId ?? "session-a");
	patchRunStatus(runDir, {
		runId,
		chartId: "demo",
		state: "running",
		pid: process.pid,
		heartbeatAt: Date.now(),
	});
	persistUserInteractionRequest(runDir, {
		runId,
		seqId,
		actionUid: { chart: "demo", state: "ask", action: "user" },
		prompt: `Question ${runId}/${seqId}?`,
		options: options.gateOptions ?? ["APPROVED", "REJECTED"],
		events: options.events ?? ["APPROVED", "REJECTED", "FAILED"],
		...(options.reply === undefined ? {} : { reply: { kind: "jsonSchema" as const, schema: options.reply } }),
	});
	return runDir;
}

function writeUserChart(name: string): string {
	const chartPath = join(tempDir, `${name}.mjs`);
	writeFileSync(chartPath, `export default {
	kind: "chart", id: "demo", initial: "ask",
	states: {
		ask: { kind: "state", action: { kind: "user", prompt: "Approve?", options: ["APPROVED", "REJECTED"] }, transitions: { APPROVED: "done", REJECTED: "done" } },
		done: { kind: "final" }
	}
};\n`);
	return chartPath;
}

function registeredCommand(): HyperchartCommand {
	let command: HyperchartCommand | undefined;
	const pi = {
		registerCommand: (name: string, config: HyperchartCommand) => {
			if (name === "hyperchart") command = config;
		},
		registerTool: () => {},
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	if (command === undefined) throw new Error("hyperchart command was not registered");
	return command;
}

function registeredToolNames(): string[] {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	return tools.map((tool) => tool.name);
}

function registeredTool(name: string): HyperchartTool {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`hyperchart tool ${name} was not registered`);
	return tool;
}

function commandContext(cwd: string): { ctx: ExtensionCommandContext; notifications: Notification[]; widgetKeys: string[] } {
	const notifications: Notification[] = [];
	const widgetKeys: string[] = [];
	return {
		notifications,
		widgetKeys,
		ctx: {
			cwd,
			mode: "print",
			model: undefined,
			sessionManager: { getSessionId: () => "session-a" },
			ui: {
				notify: (message: string, type: "info" | "warning" | "error" | undefined) => {
					notifications.push({ message, type });
				},
				setStatus: () => {},
				setWidget: (key: string, widget: unknown) => {
					if (widget !== undefined) widgetKeys.push(key);
				},
				confirm: async () => false,
				custom: async () => undefined,
			},
		} as unknown as ExtensionCommandContext,
	};
}

function createRun(runId: string, workDir: string, chartPath: string, originSessionId?: string): string {
	const runDir = join(agentDir, "hypercharts", "runs", runId);
	saveRunMeta(runDir, {
		chartPath,
		workDir,
		chartId: "demo",
		createdAt: new Date().toISOString(),
		...(originSessionId === undefined ? {} : { originSessionId }),
	});
	return runDir;
}

function writeIncompatibleReplayChart(): string {
	const chartPath = join(tempDir, "incompatible-replay.mjs");
	writeFileSync(
		chartPath,
		`export default {
	kind: "chart",
	id: "demo",
	initial: "first",
	states: {
		first: { kind: "state", action: { kind: "agent", name: "first-worker" }, transitions: { OTHER: "done" } },
		done: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}

function writeChart(name: string, sideEffectPath?: string): string {
	const chartPath = join(tempDir, `${name}.mjs`);
	const sideEffect =
		sideEffectPath === undefined
			? ""
			: `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectPath)}, "imported");\n`;
	writeFileSync(
		chartPath,
		`${sideEffect}export default {
	kind: "chart",
	id: "demo",
	initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done", FAILED: "failed" } },
		done: { kind: "final" },
		failed: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}
