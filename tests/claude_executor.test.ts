import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "../packages/hyperchart/src/index.js";
import type { AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import type { ChartEvent, JsonSchema, SchemaAst } from "../packages/hyperchart/src/core/types.js";
import { readSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { readNeutralSessionTranscript } from "../packages/hyperchart/src/inspect/session_transcript.js";
import {
	ClaudeAgentExecutor,
	FINISH_TOOL_NAME,
	type QueryFn,
} from "../packages/claude-hyperchart/src/claude/claude_agent_executor.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeWorkspace(): { workDir: string; sessionsDir: string; agentsDir: string } {
	const workDir = mkdtempSync(join(tmpdir(), "claude-exec-"));
	roots.push(workDir);
	const sessionsDir = join(workDir, "run", "sessions");
	const agentsDir = join(workDir, "agents");
	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "worker.md"),
		"---\nname: worker\nmodel: claude-test-model\nthinking: medium\ntools: Read, Bash\n---\nDo the assigned work.\n",
	);
	return { workDir, sessionsDir, agentsDir };
}

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

function effect(overrides: Partial<AgentEffect> = {}): AgentEffect {
	const actionUid = { chart: "chart", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: "chart:work:worker:1:1",
		actionUid,
		action: { kind: "agent", uid: actionUid, name: "worker" },
		events: ["DONE", "FAILED"],
		...overrides,
	};
}

type FinishCall = (args: { event: string; output?: unknown }) => Promise<unknown>;
type TurnScript = (promptText: string, finish: FinishCall) => Promise<unknown[]> | unknown[];

type FakeQuery = {
	queryFn: QueryFn;
	prompts: string[];
	steered: string[];
	options: () => Record<string, unknown>;
};

function fakeQuery(turns: TurnScript[]): FakeQuery {
	const prompts: string[] = [];
	const steered: string[] = [];
	let capturedOptions: Record<string, unknown> = {};
	const queryFn: QueryFn = (params) => {
		capturedOptions = params.options as unknown as Record<string, unknown>;
		const finish: FinishCall = (args) => {
			const servers = (params.options as { mcpServers?: Record<string, { instance?: unknown }> }).mcpServers;
			const instance = servers?.hyperchart?.instance as
				| { _registeredTools?: Record<string, { handler?: (args: unknown, extra: unknown) => Promise<unknown> }> }
				| undefined;
			const handler = instance?._registeredTools?.finish?.handler;
			if (handler === undefined) throw new Error("finish tool is not registered");
			return handler(args, {});
		};
		async function* generate() {
			yield {
				type: "system",
				subtype: "init",
				session_id: "sdk-session-1",
				model: "claude-test-model",
			} as never;
			let turnIndex = 0;
			for await (const message of params.prompt) {
				const record = message as { priority?: string; message: { content: unknown } };
				const text = typeof record.message.content === "string" ? record.message.content : "";
				if (record.priority === "now") {
					steered.push(text);
					continue;
				}
				prompts.push(text);
				const script = turns[turnIndex++] ?? (() => []);
				const messages = await script(text, finish);
				for (const value of messages) yield value as never;
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					usage: { input_tokens: 10, output_tokens: 5 },
				} as never;
			}
		}
		return generate();
	};
	return { queryFn, prompts, steered, options: () => capturedOptions };
}

function assistantMessage(blocks: unknown[]): unknown {
	return { type: "assistant", message: { role: "assistant", content: blocks } };
}

function toolResultMessage(toolUseId: string, text: string): unknown {
	return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] } };
}

function startAndAwait(executor: ClaudeAgentExecutor, target: AgentEffect): Promise<ChartEvent> {
	return new Promise((resolve) => {
		executor.start(target, (event) => resolve(event));
	});
}

describe("ClaudeAgentExecutor", () => {
	it("runs a session to a validated finish and records progress and transcript", async () => {
		const { workDir, sessionsDir, agentsDir } = makeWorkspace();
		const fake = fakeQuery([
			async (_prompt, finish) => {
				const rejected = (await finish({ event: "NOPE" })) as { isError?: boolean };
				expect(rejected.isError).toBe(true);
				await finish({ event: "DONE", output: { value: 7 } });
				return [
					assistantMessage([
						{ type: "thinking", thinking: "planning the work" },
						{ type: "text", text: "All done." },
						{ type: "tool_use", id: "call-1", name: FINISH_TOOL_NAME, input: { event: "DONE", output: { value: 7 } } },
					]),
					toolResultMessage("call-1", "Recorded. You may stop now."),
				];
			},
		]);
		const executor = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fake.queryFn,
		});

		const event = await startAndAwait(executor, effect({ reply: schema(z.object({ value: z.number() })) }));

		expect(event).toEqual({ type: "DONE", output: { value: 7 } });
		expect(fake.prompts).toHaveLength(1);
		expect(fake.prompts[0]).toContain("## Completion");
		const options = fake.options();
		expect(options.model).toBe("claude-test-model");
		expect(options.permissionMode).toBe("bypassPermissions");
		expect(options.settingSources).toEqual([]);
		expect(options.tools).toEqual(["Read", "Bash"]);
		expect(options.allowedTools).toEqual(["Read", "Bash", FINISH_TOOL_NAME]);
		expect(options.systemPrompt).toContain("Do the assigned work.");
		expect(options.systemPrompt).toContain(`Working directory: ${workDir}`);
		expect(options.thinking).toEqual({ type: "adaptive" });
		expect(options.effort).toBe("medium");

		await expect.poll(() => Object.values(readSessionProgress(sessionsDir).sessions)[0]?.status).toBe("completed");
		const progress = Object.values(readSessionProgress(sessionsDir).sessions)[0];
		expect(progress).toMatchObject({
			status: "completed",
			model: "claude-test-model",
			turnCount: 1,
			toolCount: 1,
			tokenCount: 15,
		});
		expect(progress?.sessionFile).toBeDefined();
		const transcript = readNeutralSessionTranscript(sessionsDir, progress?.sessionFile);
		expect(transcript?.map((entry) => entry.role)).toEqual(["user", "reasoning", "assistant", "tool"]);
		expect(transcript?.at(-1)).toMatchObject({ toolName: "finish", toolStatus: "completed" });
		await executor.dispose();
	});

	it("nudges a silent agent and fails after the retry budget", async () => {
		const { workDir, sessionsDir, agentsDir } = makeWorkspace();
		const fake = fakeQuery([() => [], () => [], () => []]);
		const executor = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fake.queryFn,
		});

		const event = await startAndAwait(executor, effect());

		expect(event.type).toBe("FAILED");
		expect(fake.prompts).toHaveLength(3);
		expect(fake.prompts[1]).toContain("finished responding without making an accepted tool call");
		await expect.poll(() => Object.values(readSessionProgress(sessionsDir).sessions)[0]?.status).toBe("failed");
		await executor.dispose();
	});

	it("delivers steering into the live session with priority now", async () => {
		const { workDir, sessionsDir, agentsDir } = makeWorkspace();
		let releaseTurn: (() => void) | undefined;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const fake = fakeQuery([
			async (_prompt, finish) => {
				await turnGate;
				await finish({ event: "DONE" });
				return [];
			},
		]);
		const executor = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fake.queryFn,
		});

		const done = startAndAwait(executor, effect());
		await expect.poll(() => fake.prompts.length).toBe(1);
		expect(await executor.steer("chart:work:worker", "focus on tests")).toBe(true);
		releaseTurn?.();
		await done;
		expect(fake.steered).toContain("focus on tests");
		await expect.poll(async () => executor.steer("chart:work:worker", "too late")).toBe(false);
		await executor.dispose();
	});

	it("suppresses emission when the action is cancelled mid-run", async () => {
		const { workDir, sessionsDir, agentsDir } = makeWorkspace();
		let releaseTurn: (() => void) | undefined;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const fake = fakeQuery([
			async () => {
				await turnGate;
				return [];
			},
		]);
		const executor = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fake.queryFn,
			maxFinishRetries: 5,
		});

		let emitted: ChartEvent | undefined;
		const target = effect();
		executor.start(target, (event) => {
			emitted = event;
		});
		await expect.poll(() => fake.prompts.length).toBe(1);
		executor.cancel(target.actionUid);
		releaseTurn?.();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(emitted).toBeUndefined();
		const progress = Object.values(readSessionProgress(sessionsDir).sessions)[0];
		expect(progress?.status).toBe("cancelled");
		await executor.dispose();
	});

	it("recovers a captured finish from the transcript without a new session", async () => {
		const { workDir, sessionsDir, agentsDir } = makeWorkspace();
		const target = effect();
		const fakeFirst = fakeQuery([
			async (_prompt, finish) => {
				await finish({ event: "DONE" });
				return [
					assistantMessage([
						{ type: "tool_use", id: "call-1", name: FINISH_TOOL_NAME, input: { event: "DONE" } },
					]),
					toolResultMessage("call-1", "Recorded. You may stop now."),
				];
			},
		]);
		const first = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fakeFirst.queryFn,
		});
		await startAndAwait(first, target);
		await first.dispose();

		// A restarted process must accept the already-captured finish without prompting again.
		const fakeSecond = fakeQuery([]);
		const second = new ClaudeAgentExecutor({
			workDir,
			sessionsDir,
			definitionDirs: [agentsDir],
			queryFn: fakeSecond.queryFn,
		});
		const event = await startAndAwait(second, target);
		expect(event).toEqual({ type: "DONE" });
		expect(fakeSecond.prompts).toHaveLength(0);
		await second.dispose();
	});
});

describe("claude runner", () => {
	it("runs a chart without agent actions to a complete terminal status", async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-runner-"));
		roots.push(root);
		const chartPath = join(root, "simple.chart.ts");
		writeFileSync(
			chartPath,
			`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "simple", initial: "done", states: { done: final() } });
`,
		);
		const runDir = join(root, "run");
		mkdirSync(runDir, { recursive: true });
		const configPath = join(runDir, "runner.config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				runId: "run-1",
				runDir,
				chartPath,
				chartId: "simple",
				workDir: root,
			}),
		);
		const previousCwd = process.cwd();
		try {
			const { main } = await import("../packages/claude-hyperchart/src/claude/hyperchart_runner.js");
			await main([configPath]);
		} finally {
			process.chdir(previousCwd);
		}
		const { readRunStatus } = await import("../packages/hyperchart/src/runtime/generic/run_status.js");
		const status = readRunStatus(runDir);
		expect(status?.state).toBe("complete");
		expect(readdirSync(runDir)).toContain("sessions");
	});
});
