import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queueSessionSteering, watchSessionSteering } from "../packages/hyperchart/src/runtime/generic/session_steering.js";
import { readSessionTranscript } from "../packages/pi-hyperchart/src/runtime/pi/session_transcript.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempSessions(): string {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-live-session-"));
	roots.push(root);
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	return sessions;
}

describe("live inspector sessions", () => {
	it("reads a compact transcript from a persisted Pi session", () => {
		const sessions = tempSessions();
		const file = join(sessions, "session.jsonl");
		writeFileSync(file, [
			JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Do the work", timestamp: 1_700_000_000_000 } }),
			JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Need to inspect the file first" }, { type: "text", text: "Working" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }], timestamp: 1_700_000_001_000 } }),
			JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 1_700_000_002_000 } }),
		].join("\n"));

		expect(readSessionTranscript(sessions, file)).toEqual([
			expect.objectContaining({ id: "u1", role: "user", text: "Do the work" }),
			expect.objectContaining({ id: "a1:reasoning", role: "reasoning", text: "Need to inspect the file first" }),
			expect.objectContaining({ id: "a1", role: "assistant", text: "Working" }),
			expect.objectContaining({
				id: "a1:tool:2",
				role: "tool",
				toolName: "read",
				toolCallId: "call-1",
				toolStatus: "completed",
				toolInput: expect.stringContaining('"path": "src/a.ts"'),
				toolOutput: "file contents",
			}),
		]);
	});

	it("can retain a full Pi transcript for per-visit segmentation", () => {
		const sessions = tempSessions();
		const file = join(sessions, "long-session.jsonl");
		writeFileSync(
			file,
			Array.from({ length: 130 }, (_, index) =>
				JSON.stringify({
					type: "message",
					id: `u${index}`,
					timestamp: new Date(1_700_000_000_000 + index).toISOString(),
					message: { role: "user", content: `message ${index}` },
				}),
			).join("\n"),
		);

		expect(readSessionTranscript(sessions, file)).toHaveLength(120);
		expect(readSessionTranscript(sessions, file)?.[0]?.id).toBe("u10");
		expect(readSessionTranscript(sessions, file, { limit: false })).toHaveLength(130);
	});

	it("atomically queues and delivers steering to the matching runner", async () => {
		const sessions = tempSessions();
		const delivered: string[] = [];
		const stop = watchSessionSteering(sessions, (request) => {
			delivered.push(`${request.branchId}:${request.actionKey}:${request.invokeSeqId}:${request.message}`);
			return true;
		});
		queueSessionSteering(sessions, "main", "agent-key", 17, "Change direction");
		await expect.poll(() => delivered).toEqual(["main:agent-key:17:Change direction"]);
		stop();
	});

	it("does not route a request to an executor for another branch", async () => {
		const sessions = tempSessions();
		const main: string[] = [];
		const experiment: string[] = [];
		const executors = new Map([
			["main", (message: string) => main.push(message)],
			["experiment", (message: string) => experiment.push(message)],
		]);
		const stop = watchSessionSteering(sessions, (request) => {
			executors.get(request.branchId)?.(request.message);
			return true;
		});
		queueSessionSteering(sessions, "experiment", "same-action", 22, "only experiment");
		await expect.poll(() => experiment).toEqual(["only experiment"]);
		expect(main).toEqual([]);
		stop();
	});
});
