import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "../src/index.js";
import type { AgentEffect } from "../src/core/machine.js";
import type { AgentActionAst, JsonSchema, SchemaAst } from "../src/core/types.js";
import { loadAgentDefinition, resolvePiSubagentDefinitionDirs } from "../src/runtime/pi/agent_definitions.js";
import { createFinishTool, type CompletionSink } from "../src/runtime/pi/finish_tool.js";
import { buildNudgePrompt, buildTaskPrompt } from "../src/runtime/pi/prompts.js";
import {
	buildSessionPlan,
	findCapturedFinish,
	sessionMentionsInvocationId,
} from "../src/runtime/pi/pi_agent_executor.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-pi-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

function effect(overrides: Partial<AgentEffect> = {}, actionOverrides: Partial<AgentActionAst> = {}): AgentEffect {
	const actionUid = { chart: "chart", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: "chart:work:worker:1:1",
		actionUid,
		action: { kind: "agent", uid: actionUid, name: "worker", ...actionOverrides },
		events: ["DONE", "FAILED"],
		reply: schema(z.object({ value: z.number() })),
		...overrides,
	};
}

describe("agent definitions", () => {
	it("loads markdown frontmatter with project-over-global priority", async () => {
		const project = await makeTempDir();
		const global = await makeTempDir();
		await writeFile(
			join(global, "worker.md"),
			"---\ndescription: global\ntools: read, bash\nmodel: openai/gpt-4\nthinking: high\n---\nGlobal prompt\n",
			"utf8",
		);
		await writeFile(
			join(project, "worker.md"),
			"---\ndescription: project\ntools:\n  - grep\nsystemPromptMode: append\nunknown: ignored\n---\nProject prompt\n",
			"utf8",
		);

		const definition = loadAgentDefinition("worker", [project, global]);

		expect(definition).toEqual({
			name: "worker",
			description: "project",
			systemPrompt: "Project prompt",
			tools: ["grep"],
			systemPromptMode: "append",
		});
	});

	it("resolves pi-subagents style project, user and package agent directories", async () => {
		const project = await makeTempDir();
		const agentDir = await makeTempDir();
		const packageRoot = join(agentDir, "npm", "node_modules", "agent-pack");
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(packageRoot, "agents"), { recursive: true });
		await writeFile(
			join(project, ".pi", "agents", "project-worker.md"),
			"---\nname: worker\ndescription: project\n---\nProject prompt\n",
			"utf8",
		);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:agent-pack"] }), "utf8");
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "agent-pack" }), "utf8");
		await writeFile(
			join(packageRoot, "agents", "critic.md"),
			"---\nname: critic\npackage: qa-pack\ndescription: critic\ntools: read, grep\n---\nCritic prompt\n",
			"utf8",
		);

		const dirs = resolvePiSubagentDefinitionDirs(join(project, "nested"), agentDir);

		expect(dirs[0]).toBe(join(project, ".pi", "agents"));
		expect(dirs).toContain(join(agentDir, "agents"));
		expect(dirs).toContain(join(packageRoot, "agents"));
		expect(loadAgentDefinition("worker", dirs).systemPrompt).toBe("Project prompt");
		expect(loadAgentDefinition("qa-pack.critic", dirs)).toMatchObject({
			name: "qa-pack.critic",
			tools: ["read", "grep"],
		});
	});
});

describe("finish tool", () => {
	it("captures a valid typed completion with a non-oneOf schema", async () => {
		const currentEffect = effect();
		const sink: CompletionSink = { captured: undefined };
		const tool = createFinishTool(currentEffect, sink);

		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				invocationId: { enum: [currentEffect.id] },
				event: { enum: ["DONE"] },
				output: { type: "object" },
			},
		});
		expect("oneOf" in tool.parameters).toBe(false);

		const result = await tool.execute(
			"call",
			{ invocationId: currentEffect.id, event: "DONE", output: { value: 3 } },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.terminate).toBe(true);
		expect(sink.captured).toEqual({ type: "DONE", output: { value: 3 } });
	});

	it("returns a tool error for invalid output, FAILED, and double calls", async () => {
		const currentEffect = effect();
		const sink: CompletionSink = { captured: undefined };
		const tool = createFinishTool(currentEffect, sink);

		const invalid = (await tool.execute(
			"call",
			{ invocationId: currentEffect.id, event: "DONE", output: { value: "bad" } },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean };
		expect(invalid.isError).toBe(true);
		expect(sink.captured).toBeUndefined();

		const failed = (await tool.execute(
			"call",
			{ invocationId: currentEffect.id, event: "FAILED", error: "boom" },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean };
		expect(failed.isError).toBe(true);
		expect(sink.captured).toBeUndefined();

		await tool.execute(
			"call",
			{ invocationId: currentEffect.id, event: "DONE", output: { value: 1 } },
			undefined,
			undefined,
			{} as never,
		);
		const second = (await tool.execute(
			"call",
			{ invocationId: currentEffect.id, event: "DONE", output: { value: 2 } },
			undefined,
			undefined,
			{} as never,
		)) as { isError?: boolean };
		expect(second.isError).toBe(true);
		expect(sink.captured).toEqual({ type: "DONE", output: { value: 1 } });
	});
});

describe("pi executor helpers", () => {
	it("builds session plan from action overrides before definition defaults", () => {
		const definition = {
			name: "worker",
			systemPrompt: "prompt",
			tools: ["read"],
			model: "anthropic/claude",
			thinking: "low" as const,
			systemPromptMode: "append" as const,
		};
		const plan = buildSessionPlan(definition, effect({}, { model: "openai/gpt", thinking: "high", tools: ["bash"] }), {
			defaultModel: "fallback/model",
		});

		expect(plan).toEqual({
			modelRef: "openai/gpt",
			thinkingLevel: "high",
			tools: ["bash", "finish"],
			promptMode: "append",
		});
	});

	it("only resumes a session that mentions the current invocation id", async () => {
		const dir = await makeTempDir();
		const sessionFile = join(dir, "session.jsonl");
		await writeFile(sessionFile, JSON.stringify({ content: "chart:work:worker:1:1" }), "utf8");

		expect(sessionMentionsInvocationId(sessionFile, "chart:work:worker:1:1")).toBe(true);
		expect(sessionMentionsInvocationId(sessionFile, "chart:work:worker:1:2")).toBe(false);
		expect(sessionMentionsInvocationId(join(dir, "missing.jsonl"), "chart:work:worker:1:1")).toBe(false);
	});

	it("does not recover stale finish calls for a newer rejected phase", () => {
		const messages = [
			{ role: "user", content: "task with invocation chart:work:worker:1:1" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "finish",
						id: "call-1",
						arguments: { invocationId: "chart:work:worker:1:1", event: "DONE", output: { value: 1 } },
					},
				],
			},
			{ role: "toolResult", toolName: "finish", toolCallId: "call-1", isError: false },
		];

		expect(findCapturedFinish(messages, effect({ id: "chart:work:worker:1:3" }))).toBeUndefined();
	});

	it("builds a corrective nudge when the model writes textual tool-call syntax", () => {
		const prompt = buildNudgePrompt(effect(), "read<arg_key>path</arg_key><arg_value>context.json</arg_value>");

		expect(prompt).toContain("actual tool-calling interface");
		expect(prompt).toContain("Plain text like `read<arg_key>...`");
		expect(prompt).toContain("## Completion");
		expect(prompt).toContain(`invocationId: exactly ${JSON.stringify(effect().id)}`);
	});

	it("builds task prompts with selected reads, deliverables and completion contract", () => {
		const prompt = buildTaskPrompt(
			effect({
				task: "Do the work.",
				reads: [{ path: "facts.json", select: "facts", shape: schema(z.object({ facts: z.array(z.string()) })) }],
				artifacts: [{ path: "out.json", shape: schema(z.object({ ok: z.boolean() })) }],
			}),
			[{ artifact: { path: "facts.json", select: "facts" }, value: ["a"] }],
		);

		expect(prompt).toContain("Do the work.");
		expect(prompt).toContain("## Files to read first");
		expect(prompt).toContain("facts (from facts.json)");
		expect(prompt).toContain("## Deliverables");
		expect(prompt).toContain("## Completion");
		expect(prompt).toContain(`invocationId: exactly ${JSON.stringify(effect().id)}`);
	});

	it("finds a successful finish call after the last user message in restored messages", () => {
		const currentEffect = effect();
		const messages = [
			{ role: "user", content: "old" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "old",
						name: "finish",
						arguments: { invocationId: "old-invocation", event: "DONE", output: { value: 1 } },
					},
				],
			},
			{ role: "toolResult", toolCallId: "old", toolName: "finish", isError: false },
			{ role: "user", content: "new" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "new",
						name: "finish",
						arguments: { invocationId: currentEffect.id, event: "DONE", output: { value: 2 } },
					},
				],
			},
			{ role: "toolResult", toolCallId: "new", toolName: "finish", isError: false },
		];

		expect(findCapturedFinish(messages, currentEffect)).toEqual({ type: "DONE", output: { value: 2 } });
	});
});
