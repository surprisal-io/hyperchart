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

	it("atomically queues and delivers steering to the matching runner", async () => {
		const sessions = tempSessions();
		const delivered: string[] = [];
		const stop = watchSessionSteering(sessions, (request) => {
			delivered.push(`${request.actionKey}:${request.message}`);
			return true;
		});
		queueSessionSteering(sessions, "agent-key", "Change direction");
		await expect.poll(() => delivered).toEqual(["agent-key:Change direction"]);
		stop();
	});
});
