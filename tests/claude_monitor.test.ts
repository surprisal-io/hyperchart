import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitPendingClaudeTerminalNotifications, pendingOwnedClaudeTerminalRequests } from "../packages/claude-hyperchart/src/monitor.js";
import { watchRun } from "../packages/claude-hyperchart/src/mcp/spawn_runner.js";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus, readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
	const root = mkdtempSync(join(tmpdir(), "claude-monitor-"));
	roots.push(root);
	const runsRoot = join(root, "runs");
	const cwd = join(root, "project");
	mkdirSync(runsRoot, { recursive: true });
	mkdirSync(cwd);
	return { root, runsRoot, cwd };
}

function createRequest(
	runsRoot: string,
	cwd: string,
	name: string,
	sessionId: string,
	status: "complete" | "failed" | "running" = "complete",
) {
	const runDir = join(runsRoot, name);
	saveRunMeta(runDir, {
		chartPath: join(cwd, "chart.ts"),
		workDir: cwd,
		chartId: "chart",
		createdAt: new Date().toISOString(),
		originSessionId: sessionId,
	});
	persistTerminalNotificationRequest(runDir, {
		runId: name,
		runDir,
		chartId: "chart",
		outcome: "complete",
		prompt: "line one\nline two",
		artifacts: [],
	});
	patchRunStatus(runDir, { runId: name, chartId: "chart", state: status, ...(status === "running" ? { heartbeatAt: Date.now() } : {}) });
	return runDir;
}

describe("Claude terminal monitor", () => {
	it("routes by exact session and workDir, writes one physical line, and receipts once", () => {
		const { runsRoot, cwd, root } = world();
		const owned = createRequest(runsRoot, cwd, "owned", "session-a");
		createRequest(runsRoot, cwd, "foreign-session", "session-b");
		createRequest(runsRoot, join(root, "other"), "foreign-workdir", "session-a");
		const lines: string[] = [];

		expect(emitPendingClaudeTerminalNotifications({ runsRoot, cwd, sessionId: "session-a", writeLine: (line) => lines.push(line) })).toBe(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
		const emitted = JSON.parse(lines[0]!);
		expect(emitted).toMatchObject({
			customType: "hyperchart-terminal",
			requestId: emitted.details.requestId,
			content: "line one\nline two",
			details: { payload: { runId: "owned" } },
		});
		expect(hasTerminalNotificationReceipt(owned, "claude", "session-a")).toBe(true);
		expect(emitPendingClaudeTerminalNotifications({ runsRoot, cwd, sessionId: "session-a", writeLine: (line) => lines.push(line) })).toBe(0);
	});

	it("recovers a pre-delivery crash after the claim lease expires", () => {
		const { runsRoot, cwd } = world();
		const runDir = createRequest(runsRoot, cwd, "crashed-before-write", "session-a");
		expect(claimTerminalNotificationReceipt(runDir, "claude", "session-a", { now: 1, leaseMs: 1 })).toBe(true);
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(false);
		const lines: string[] = [];

		expect(emitPendingClaudeTerminalNotifications({ runsRoot, cwd, sessionId: "session-a", writeLine: (line) => lines.push(line) })).toBe(1);
		expect(lines).toHaveLength(1);
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(true);
	});

	it("leaves a failed stdout write recoverable instead of confirming it", () => {
		const { runsRoot, cwd } = world();
		const runDir = createRequest(runsRoot, cwd, "write-failed", "session-a");
		expect(() => emitPendingClaudeTerminalNotifications({
			runsRoot,
			cwd,
			sessionId: "session-a",
			writeLine: () => { throw new Error("stdout closed"); },
		})).toThrow("stdout closed");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(false);
	});

	it("waits for status/outcome agreement", () => {
		const { runsRoot, cwd } = world();
		const runDir = createRequest(runsRoot, cwd, "running", "session-a", "running");
		expect(pendingOwnedClaudeTerminalRequests({ runsRoot, cwd, sessionId: "session-a" })).toEqual([]);
		patchRunStatus(runDir, { state: "failed" });
		expect(pendingOwnedClaudeTerminalRequests({ runsRoot, cwd, sessionId: "session-a" })).toEqual([]);
		patchRunStatus(runDir, { state: "complete" });
		expect(pendingOwnedClaudeTerminalRequests({ runsRoot, cwd, sessionId: "session-a" })).toHaveLength(1);
	});

	it("the dead-run watcher preserves a request written before the status crash", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		const { runsRoot, cwd } = world();
		const runDir = createRequest(runsRoot, cwd, "request-before-status", "session-a", "running");
		patchRunStatus(runDir, { pid: 999_999_999, heartbeatAt: 1 });
		const done = watchRun(runDir);

		await vi.advanceTimersByTimeAsync(21_000);
		await expect(done).resolves.toMatchObject({ state: "complete", exitCode: 0 });
		expect(readRunStatus(runDir)).toMatchObject({ state: "complete", exitCode: 0 });
	});

	it("keeps scanning for requests created after monitor startup", async () => {
		const { runsRoot, cwd } = world();
		const child = spawn(process.execPath, ["packages/claude-hyperchart/bin/hyperchart-monitor.mjs"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HYPERCHART_RUNS_ROOT: runsRoot,
				HYPERCHART_MONITOR_INTERVAL_MS: "20",
				CLAUDE_PROJECT_DIR: cwd,
				CLAUDE_CODE_SESSION_ID: "session-a",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 60));
			const runDir = createRequest(runsRoot, cwd, "late", "session-a");
			const line = await new Promise<string>((resolve, reject) => {
				let buffer = "";
				const timeout = setTimeout(() => reject(new Error("monitor did not emit a notification")), 3_000);
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					clearTimeout(timeout);
					resolve(buffer.slice(0, newline));
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`monitor exited early (${code})`));
				});
			});
			expect(JSON.parse(line)).toMatchObject({ details: { payload: { runId: "late" } } });
			await vi.waitFor(() => expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(true));
		} finally {
			child.kill("SIGTERM");
		}
	});

	it("registers an always-on persistent plugin monitor", () => {
		const plugin = JSON.parse(readFileSync("packages/claude-hyperchart/.claude-plugin/plugin.json", "utf8"));
		expect(plugin.experimental.monitors).toEqual([
			expect.objectContaining({ name: "hyperchart-terminal", when: "always" }),
		]);
		const executable = readFileSync("packages/claude-hyperchart/bin/hyperchart-monitor.mjs", "utf8");
		expect(executable).toContain("scan();");
		expect(executable).toContain("setInterval(scan, intervalMs)");
	});
});
