import { describe, expect, it } from "vitest";
import {
	MAX_TOOL_PAYLOAD_BYTES,
	ReplyContractSummaryError,
	assertToolPayloadSafe,
	boundedModelEnvelope,
	summarizeChartInspect,
	summarizeRunInspect,
	summarizeUserGate,
} from "../packages/hyperchart/src/host/index.js";
import type { HyperchartInspectResult } from "../packages/hyperchart/src/core/inspect_ast.js";
import type { HyperchartRunInfo } from "../packages/hyperchart/src/host/models.js";
import { answerFromReplySummary } from "./reply_summary_helpers.js";

const LARGE_TEXT = "full-payload-marker:" + "x".repeat(20_000);

describe("model-facing tool payload boundary", () => {
	it("keeps realistic large chart and run digests below 64 KiB without full-only fields", () => {
		const chart: HyperchartInspectResult = {
			chartId: "large-chart",
			chartPath: "/tmp/large-chart.chart.ts",
			mode: "static",
			definitionSource: LARGE_TEXT,
			states: Array.from({ length: 1_000 }, (_, index) => ({
				id: `state-${index}`,
				kind: "agent" as const,
				definitionSource: LARGE_TEXT,
				task: LARGE_TEXT,
				inputs: [{ name: "input", required: true, schema: { type: "string", description: LARGE_TEXT } }],
				tools: Array.from({ length: 25 }, (_, item) => `tool-${item}`),
				reads: Array.from({ length: 25 }, (_, item) => `read-${item}`),
				artifacts: Array.from({ length: 25 }, (_, item) => ({ name: `artifact-${item}`, path: `artifact-${item}.json` })),
				transitions: Array.from({ length: 25 }, (_, item) => ({ event: `EVENT_${item}`, target: `state-${item + 1}` })),
			})),
		};
		const run: HyperchartRunInfo = {
			runId: "large-run",
			chartName: "large-chart",
			mode: "run",
			status: "running",
			cwd: "/tmp/project",
			createdAt: 1,
			updatedAt: 2,
			args: { secretLargeInput: LARGE_TEXT, nested: { full: LARGE_TEXT } },
			stateCount: 1_000,
			definitionSource: LARGE_TEXT,
			states: Array.from({ length: 1_000 }, (_, index) => ({
				id: `state-${index}`,
				status: index === 0 ? "running" as const : "done" as const,
				type: "agent" as const,
				definitionSource: LARGE_TEXT,
				taskPrompt: LARGE_TEXT,
				visits: 500,
				visitHistory: [{
					visit: 1,
					invokeSeqId: 1,
					startedAt: 1,
					status: "done" as const,
					invocation: { kind: "agent" as const },
					session: {
						actionKey: "large-chart:state-0:agent",
						status: "completed",
						messages: [{ id: "m", role: "assistant" as const, text: LARGE_TEXT }],
					},
				}],
				...(index === 0 ? {
					artifacts: Array.from({ length: 25 }, (_, item) => ({ name: `artifact-${item}`, path: `artifact-${item}.json` })),
					issues: Array.from({ length: 25 }, (_, item) => ({ severity: "warning" as const, kind: "session_failed" as const, message: `issue-${item}`, source: "session_progress" as const })),
					session: {
						actionKey: "large-chart:state-0:agent",
						status: "running",
						tools: Array.from({ length: 25 }, (_, item) => `tool-${item}`),
						messages: [{ id: "m", role: "assistant" as const, text: LARGE_TEXT }],
						lastMessage: LARGE_TEXT,
					},
				} : {}),
			})),
		};

		const chartSummary = summarizeChartInspect(chart);
		const runSummary = summarizeRunInspect(run);
		expect(chartSummary.stateDigests[0]).toMatchObject({ omittedToolCount: 5, omittedReadCount: 5, omittedArtifactCount: 5, omittedTransitionCount: 5 });
		expect(runSummary.stateDigests[0]).toMatchObject({ omittedArtifactCount: 5, omittedIssueCount: 5, sessionDigest: { omittedToolCount: 5 } });
		for (const payload of [chartSummary, runSummary]) {
			expect(() => assertToolPayloadSafe(payload)).not.toThrow();
			const json = JSON.stringify(payload);
			expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD_BYTES);
			expect(json).not.toContain(LARGE_TEXT);
			expect(json).not.toContain("x".repeat(1_000));
			expect(json).not.toMatch(/"(?:definitionSource|schema|schemas|states|visits|visitHistory|messages|transcripts|taskPrompt|args)"\s*:/);
		}
	});

	it("rejects nested full models, aliases, plurals, and arbitrary unreviewed fields", () => {
		for (const key of [
			"source", "definitionSource", "states", "visits", "visitHistory", "schema", "schemas", "messages", "transcript",
			"transcripts", "prompt", "prompts", "reply", "replies", "args", "definition", "notification", "notificationPayload", "notificationPayloads", "payload", "payloads",
		]) {
			expect(() => assertToolPayloadSafe({ details: { [key]: { text: "leak" } } })).toThrow(/not allowlisted/);
		}
		expect(() => assertToolPayloadSafe({ details: { benignLookingAlias: "leak" } })).toThrow(/not allowlisted/);
		expect(() => assertToolPayloadSafe({ text: "x".repeat(MAX_TOOL_PAYLOAD_BYTES + 1) })).toThrow(/exceeds/);
	});

	it("rejects circular payloads but accepts shared non-circular references", () => {
		const circular: { details?: unknown } = {};
		circular.details = circular;
		expect(() => assertToolPayloadSafe(circular)).toThrow(/circular/);
		const shared = { text: "shared" };
		const sharedEmpty = {};
		expect(() => assertToolPayloadSafe({ records: [shared, shared, sharedEmpty, sharedEmpty] })).not.toThrow();
		expect(() => assertToolPayloadSafe({ details: { input: sharedEmpty, output: sharedEmpty } })).not.toThrow();
	});

	it("uses a deterministic bounded fallback after constructing the complete envelope", () => {
		const make = () => boundedModelEnvelope<{
			content: Array<{ type: string; text: string }>;
			details?: { error: string; digest: string; originalBytes: number; maxBytes: number };
		}>(
			{ content: [{ type: "text", text: "x".repeat(MAX_TOOL_PAYLOAD_BYTES + 1) }] },
			({ digest, originalBytes, maxBytes }) => ({ content: [{ type: "text", text: "bounded" }], details: { error: "model-envelope-too-large", digest, originalBytes, maxBytes } }),
		);
		const first = make();
		const second = make();
		expect(first).toEqual(second);
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD_BYTES);
		expect(first).toMatchObject({ details: { error: "model-envelope-too-large", digest: expect.stringMatching(/^fnv1a32:/) } });
	});

	it("recursively summarizes every construct needed to produce a constrained gate answer", () => {
		const summary = summarizeUserGate({
			runId: "gate", seqId: 1, prompt: "Choose and explain", options: Array.from({ length: 25 }, (_, index) => `option-${index}`),
			events: Array.from({ length: 25 }, (_, index) => `EVENT_${index}`),
			reply: { kind: "jsonSchema", schema: {
				type: "object",
				properties: {
					decision: { type: "string", enum: ["approve", "reject"] },
					review: { type: "object", properties: {
						note: { type: "string", minLength: 3, maxLength: 12, pattern: "^[a-z]+$", format: "plain" },
						priority: { type: "integer", minimum: 1, maximum: 5, default: 2 },
						optionalNote: { type: "string" },
					}, required: ["note", "priority"], additionalProperties: false },
					findings: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: {
						kind: { type: "string", const: "finding" },
						value: { anyOf: [{ type: "string", const: "ok" }, { type: "integer", minimum: 1 }] },
					}, required: ["kind", "value"], additionalProperties: false } },
					comment: { anyOf: [{ type: "null" }, { type: "string", const: "none" }] },
				},
				required: ["decision", "review", "findings", "comment"], additionalProperties: false,
			} },
		});
		expect(summary).toMatchObject({
			outputRequired: true,
			promptPreview: { text: "Choose and explain", originalChars: 18, omittedChars: 0 },
			options: expect.arrayContaining([{ label: { text: "option-0", originalChars: 8, omittedChars: 0 }, value: "option-0" }]),
			allowedEvents: expect.arrayContaining(["EVENT_0", "EVENT_24"]),
			outputHint: {
				types: ["object"], additionalProperties: "forbidden",
				fields: [
					expect.objectContaining({ name: "decision", required: true, optional: false, value: { types: ["string"], allowedValueJson: ['"approve"', '"reject"'] } }),
					expect.objectContaining({ name: "review", value: expect.objectContaining({ fields: expect.arrayContaining([
						expect.objectContaining({ name: "note", value: expect.objectContaining({ constraints: expect.objectContaining({ minLength: 3, maxLength: 12, pattern: "^[a-z]+$", format: "plain" }) }) }),
						expect.objectContaining({ name: "priority", value: expect.objectContaining({ types: ["integer"], hasDefault: true, defaultJson: "2", constraints: expect.objectContaining({ minimum: 1, maximum: 5 }) }) }),
						expect.objectContaining({ name: "optionalNote", required: false, optional: true }),
					]) }) }),
					expect.objectContaining({ name: "findings", value: expect.objectContaining({ constraints: expect.objectContaining({ minItems: 1, maxItems: 3 }), element: expect.objectContaining({ types: ["object"] }) }) }),
					expect.objectContaining({ name: "comment", value: expect.objectContaining({ nullable: true, alternativeMode: "anyOf", alternatives: expect.any(Array) }) }),
				],
			},
		});
		const answer = answerFromReplySummary(summary.outputHint!);
		expect(answer).toEqual({ decision: "approve", review: { note: "xxx", priority: 2 }, findings: [{ kind: "finding", value: "ok" }], comment: null });
		expect(JSON.stringify(summary)).not.toMatch(/"(?:schema|reply|prompt)"\s*:/);
		expect(() => assertToolPayloadSafe(summary)).not.toThrow();
	});

	it("preserves response identities exactly and accounts for every truncated display string", () => {
		const runId = `run-${"r".repeat(180)}`;
		const event = `EVENT_${"e".repeat(180)}`;
		const option = `Option ${"o".repeat(180)}`;
		const prompt = `Question ${"q".repeat(1_200)}`;
		const summary = summarizeUserGate({ runId, seqId: Number.MAX_SAFE_INTEGER, prompt, options: [option], events: [event, "FAILED"] });

		expect(summary.runId).toBe(runId);
		expect(summary.seqId).toBe(Number.MAX_SAFE_INTEGER);
		expect(summary.allowedEvents).toEqual([event]);
		expect(summary.allowedEvents[0]).not.toContain("…");
		expect(summary.options).toEqual([{
			label: { text: `${option.slice(0, 159)}…`, originalChars: option.length, omittedChars: option.length - 159 },
			value: option,
		}]);
		expect(summary.options[0]?.value).not.toContain("…");
		expect(summary.promptPreview).toEqual({
			text: `${prompt.slice(0, 999)}…`,
			originalChars: prompt.length,
			omittedChars: prompt.length - 999,
		});
	});

	it("fails closed rather than truncating an unsafe response identity", () => {
		const oversized = "x".repeat(2_001);
		for (const request of [
			{ runId: oversized, seqId: 1, prompt: "answer", options: [], events: ["DONE"] },
			{ runId: "run", seqId: 1, prompt: "answer", options: [], events: [oversized] },
			{ runId: "run", seqId: 1, prompt: "answer", options: [oversized], events: ["DONE"] },
		]) {
			expect(() => summarizeUserGate(request)).toThrow(/identity.*cannot be truncated.*browser inspector/i);
		}
	});

	it("fails closed with omission metadata when depth, node, collection, or byte caps prevent a sufficient contract", () => {
		const summarize = (schema: Record<string, unknown>) => summarizeUserGate({ runId: "capped", seqId: 1, prompt: "answer", options: [], events: ["DONE"], reply: { kind: "jsonSchema", schema } });
		try {
			summarize({ type: "string", enum: Array.from({ length: 41 }, (_, index) => `value-${index}`) });
			throw new Error("expected summary cap failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ReplyContractSummaryError);
			expect((error as ReplyContractSummaryError).metadata).toEqual({ path: "$/enum", limit: "collection", collection: "allowedValueJson", omittedCount: 1 });
			expect((error as Error).message).toMatch(/1 entries would be omitted.*browser inspector/i);
		}
		let deep: Record<string, unknown> = { type: "string" };
		for (let index = 0; index < 14; index++) deep = { type: "array", items: deep };
		expect(() => summarize(deep)).toThrow(/depth exceeds.*browser inspector/i);
		const nodeTree = (levels: number): Record<string, unknown> => levels === 0
			? { type: "string" }
			: { anyOf: Array.from({ length: 6 }, () => nodeTree(levels - 1)) };
		expect(() => summarize(nodeTree(3))).toThrow(/node count exceeds.*browser inspector/i);
		expect(() => summarize({ type: "object", properties: Object.fromEntries(Array.from({ length: 161 }, (_, index) => [`field${index}`, { type: "object", properties: {} }])) })).toThrow(/collection 'fields'.*121 entries would be omitted/i);
		expect(() => summarize({ type: "object", properties: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, { type: "string", pattern: "a".repeat(500) }])) })).toThrow(/summary exceeds.*byte cap.*browser inspector/i);
		expect(() => summarize({ type: "string", default: "x".repeat(2_001) })).toThrow(/bytes would be omitted.*browser inspector/i);
		expect(() => summarize({ type: "object", patternProperties: { ".*": { type: "string" } } })).toThrow(/Unsupported validation keyword.*browser inspector/i);
	});

	it("resolves local schema references and reports self-reference as recursion, not depth overflow", () => {
		const summarize = (schema: Record<string, unknown>) => summarizeUserGate({ runId: "ref", seqId: 1, prompt: "answer", options: [], events: ["DONE"], reply: { kind: "jsonSchema", schema } });
		const resolved = summarize({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$defs: { decision: { type: "string", enum: ["approve", "reject"] } },
			type: "object",
			properties: { decision: { $ref: "#/$defs/decision" } },
			required: ["decision"],
			additionalProperties: false,
		});
		expect(resolved.outputHint?.fields?.[0]?.value).toMatchObject({ types: ["string"], allowedValueJson: ['"approve"', '"reject"'] });

		// A root-level $ref with a $defs sibling is the shape schema generators emit.
		const rootRef = summarize({ $defs: { answer: { type: "string", minLength: 2 } }, $ref: "#/$defs/answer" });
		expect(rootRef.outputHint).toMatchObject({ types: ["string"], constraints: { minLength: 2 } });

		expect(() => summarize({
			$defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
			$ref: "#/$defs/node",
		})).toThrow(/Recursive schema reference '#\/\$defs\/node'.*browser inspector/i);
		expect(() => summarize({ $ref: "#/$defs/missing" })).toThrow(/Unresolved schema reference/);
		expect(() => summarize({ $ref: "https://example.com/schema.json" })).toThrow(/Only local JSON Schema references/);
		expect(() => summarize({ $defs: { answer: { type: "string" } }, $ref: "#/$defs/answer", minLength: 2 })).toThrow(/sibling validation keywords/);
	});
});
