import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actor, agent, arg, artifact, artifactOf, actorInput, call, chart, failed, final, item, map, message, messageInput, protocol, receive, reply, result, script, send, t } from "../packages/hyperchart/src/core/dsl.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { hyperchartSource } from "../packages/hyperchart/src/core/source.js";

function sourceForScript() {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "script-source",
			initial: "run",
			states: {
				run: {
					kind: "state",
					action: script("echo", [], { env: { FOO: "bar" } }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!parsed.ok) throw new Error("expected valid chart");
	return hyperchartSource(parsed.ast);
}

describe("hyperchart source", () => {
	it("prints chart argument metadata in generated definition source", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "argument-source",
			args: { topic: { description: "Research subject", default: "Hyperchart" } },
			initial: "done",
			states: { done: final() },
		}));
		assert(parsed.ok, JSON.stringify(parsed.diagnostics));

		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("args: {");
		expect(source).toContain('description: "Research subject"');
		expect(source).toContain('default: "Hyperchart"');
	});

	it("keeps the positional args slot when script options exist without args", () => {
		const source = sourceForScript();
		expect(source).toMatch(/script\("echo", \[\], \{\s+env:/);
		expect(source).toContain('FOO: "bar"');
	});

	it("prints complete and failed terminals with notification options", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "terminal-source",
			initial: "work",
			states: {
				work: { kind: "state", action: agent("worker", { artifacts: { report: artifact("report.txt") } }), transitions: { DONE: "done", ERROR: "failed" } },
				done: final(),
				failed: failed({ notify: { prompt: t`Failure ${result("work")}`, artifacts: [artifactOf("work", { artifact: "report" })], scope: "work" } }),
			},
		}));
		assert(parsed.ok, JSON.stringify(parsed.diagnostics));
		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("done: final()");
		expect(source).toContain("failed: failed({");
		expect(source).toContain('scope: "work"');
		expect(source).toContain('artifactOf("work", {');
	});

	it("renders stable actor capability bindings that round-trip for root and map-local actors", () => {
		const Protocol = protocol({ READ: message({ input: z.object({ path: z.string() }), reply: z.object({ text: z.string() }) }) });
		const Reader = actor({
			input: z.object({ root: z.string() }), protocol: Protocol, initial: "idle",
			states: {
				idle: receive({ on: { READ: "answer" } }),
				answer: reply({ target: "idle", output: { text: "ok" } }),
			},
		});
		const rootReader = Reader({ root: "root" });
		const itemReader = Reader({ root: item("root") });
		const parsed = normalizeChartConfig(chart({
			kind: "chart", id: "actor-source", actors: { rootReader }, initial: "read",
			states: {
				read: call({ to: rootReader, event: "READ", input: { path: "a" }, target: "items" }),
				items: map({
					over: arg("items"), actors: { itemReader }, initial: "send", onDone: "done",
					states: { send: send({ to: itemReader, event: "READ", input: { path: "b" }, target: "finished" }), finished: final() },
				}),
				done: final(),
			},
		}));
		assert(parsed.ok, JSON.stringify(parsed.diagnostics));
		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("const actorDeclaration1");
		expect(source).toContain("to: actorDeclaration");
		expect(source).not.toContain('to: "@rootReader"');
		const scope = { actor, agent, arg, artifact, artifactOf, actorInput, call, chart, failed, final, item, map, message, messageInput, protocol, receive, reply, result, script, send, t, z };
		const rebuilt = Function(...Object.keys(scope), `return (${source});`)(...Object.values(scope));
		const roundTrip = normalizeChartConfig(rebuilt);
		assert(roundTrip.ok, JSON.stringify(roundTrip.diagnostics));
		expect(roundTrip.ast).toEqual(parsed.ast);
	});

	it("renders selected actor declarations and internal states instead of undefined", () => {
		const Protocol = protocol({ PING: message({ input: z.object({}) }) });
		const Worker = actor({
			input: z.object({}), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const worker = Worker({});
		const parsed = normalizeChartConfig(chart({
			kind: "chart", id: "selected-actor-source", actors: { worker }, initial: "done", states: { done: final() },
		}));
		assert(parsed.ok, JSON.stringify(parsed.diagnostics));
		expect(hyperchartSource(parsed.ast, "@worker")).toContain("worker: actor(");
		expect(hyperchartSource(parsed.ast, "@worker.idle")).toContain("idle: receive(");
		expect(hyperchartSource(parsed.ast, "@worker.settle")).toContain("settle: reply(");
	});

	it("preallocates actor declarations before actor-workflow dependencies", () => {
		const TargetProtocol = protocol({ PING: message({ input: z.object({ id: z.number() }) }) });
		const Target = actor({
			input: z.object({}), protocol: TargetProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const zTarget = Target({});
		const SourceProtocol = protocol({ GO: message({ input: z.object({ id: z.number() }) }) });
		const Source = actor({
			input: z.object({}), protocol: SourceProtocol, initial: "idle",
			states: {
				idle: receive({ on: { GO: "forward" } }),
				forward: send({ to: zTarget, event: "PING", input: { id: messageInput("GO", "id") }, target: "settle" }),
				settle: reply({ target: "idle" }),
			},
		});
		const aSource = Source({});
		const parsed = normalizeChartConfig(chart({
			kind: "chart", id: "actor-dependency-source", actors: { aSource, zTarget }, initial: "done", states: { done: final() },
		}));
		assert(parsed.ok, JSON.stringify(parsed.diagnostics));

		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("aSource: actorDeclaration1");
		expect(source).toContain("zTarget: actorDeclaration2");
		expect(source).toContain("to: actorDeclaration2");
		expect(source).toContain("const actorDeclaration1 = Object.create(null)");
		expect(source).toContain("const actorDeclaration2 = Object.create(null)");
		expect(source.indexOf("const actorDeclaration2")).toBeLessThan(source.indexOf("Object.assign(actorDeclaration1"));
		const scope = { actor, agent, arg, artifact, artifactOf, actorInput, call, chart, failed, final, item, map, message, messageInput, protocol, receive, reply, result, script, send, t, z };
		const rebuilt = Function(...Object.keys(scope), `return (${source});`)(...Object.values(scope));
		const roundTrip = normalizeChartConfig(rebuilt);
		assert(roundTrip.ok, JSON.stringify(roundTrip.diagnostics));
		expect(roundTrip.ast).toEqual(parsed.ast);
	});

	it("preserves common JSON Schema constraints in generated Zod definitions", () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "schema-source",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", {
							reply: z.object({
								score: z.number().min(5).max(10).multipleOf(0.5),
								slug: z
									.string()
									.min(3)
									.max(20)
									.regex(/^[a-z]+$/),
								tags: z.array(z.string()).min(1).max(3),
							}),
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("expected valid chart");
		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("z.number().min(5).max(10).multipleOf(0.5)");
		expect(source).toContain('z.string().min(3).max(20).regex(new RegExp("^[a-z]+$"))');
		expect(source).toContain("z.array(z.string()).min(1).max(3)");
	});
});
