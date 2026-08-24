import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import type { JsonSchema, SchemaAst } from "../packages/hyperchart/src/core/types.js";
import { z } from "../packages/hyperchart/src/index.js";
import { createInvocationCustomTools } from "../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";
import type { CompletionSink } from "../packages/pi-hyperchart/src/runtime/pi/finish_tool.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

function effect(): AgentEffect {
	const actionUid = { chart: "chart", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: "chart:work:worker:1:1",
		actionUid,
		action: { kind: "agent", uid: actionUid, name: "worker" },
		events: ["DONE", "FAILED"],
		reply: schema(z.object({ value: z.number() })),
	};
}

function customTool(name: string): ToolDefinition {
	return defineTool({
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: name }], details: { name } };
		},
	}) as ToolDefinition;
}

describe("Pi invocation custom tools", () => {
	it("keeps custom tools invocation-scoped and always appends a usable finish tool", async () => {
		const firstSink: CompletionSink = { captured: undefined };
		const secondSink: CompletionSink = { captured: undefined };
		const firstCustom = customTool("first_only");
		const secondCustom = customTool("second_only");

		const first = createInvocationCustomTools(effect(), firstSink, undefined, [firstCustom]);
		const second = createInvocationCustomTools(effect(), secondSink, undefined, [secondCustom]);

		expect(first.map((tool) => tool.name)).toEqual(["first_only", "finish"]);
		expect(second.map((tool) => tool.name)).toEqual(["second_only", "finish"]);
		expect(first).not.toContain(secondCustom);
		expect(second).not.toContain(firstCustom);

		const finish = first.find((tool) => tool.name === "finish");
		expect(finish).toBeDefined();
		const result = await finish?.execute(
			"finish-call",
			{ event: "DONE", output: { value: 7 } },
			undefined,
			undefined,
			{} as never,
		);

		expect(result?.terminate).toBe(true);
		expect(firstSink.captured).toEqual({ type: "DONE", output: { value: 7 } });
		expect(secondSink.captured).toBeUndefined();
	});
});
