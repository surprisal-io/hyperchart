import { z } from "zod";
import {
	agent,
	arg,
	chart,
	emit,
	event,
	final,
	gate,
	input,
	item,
	key,
	map,
	result,
	t,
	tsImport,
	visit,
} from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartCst } from "../../core/types.js";
import { explainReplay } from "../../core/replay_check.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import { capturedStorySchedule } from "./capture-story-schedule.js";
import { actionAt, storyArgs, storyScenario } from "./story-scenario.js";

const startedAt = Date.UTC(2026, 8, 18, 15, 0, 0);
const stamp = (seqId: number) => ({
	seqId,
	parentId: seqId === 1 ? null : seqId - 1,
	branchId: "main",
	timestamp: startedAt + seqId * 1_000,
});

const GateReply = z
	.object({
		approvedBy: z.string(),
		changeWindow: z.string(),
		note: z.string().optional(),
	})
	.strict();

export function gateStoryDefinition(requestLabel = "production deploy"): ChartCst {
	return chart({
		kind: "chart",
		id: "storybook-host-release-gate",
		args: {
			releaseId: { description: "Release awaiting host approval.", schema: z.string() },
			environment: {
				description: "Deployment environment.",
				schema: z.enum(["staging", "production"]),
				default: "production",
			},
		},
		initial: "release-gate",
		states: {
			"release-gate": {
				kind: "state",
				action: gate({
					event: "release.approval-requested",
					payload: {
						requestLabel,
						releaseId: arg("releaseId"),
						environment: arg("environment"),
						checks: ["typecheck", "unit", "storybook"],
					},
					reply: GateReply,
				}),
				emit: [
					emit({
						event: "release.approved",
						payload: {
							releaseId: arg("releaseId"),
							approvedBy: result("release-gate", "approvedBy"),
							changeWindow: result("release-gate", "changeWindow"),
						},
					}),
				],
				transitions: {
					APPROVED: {
						target: "deploy",
						input: {
							approvedBy: event("approvedBy"),
							changeWindow: event("changeWindow"),
						},
					},
					CANCELLED: "cancelled",
				},
			},
			deploy: {
				kind: "state",
				input: { approvedBy: z.string(), changeWindow: z.string() },
				action: agent("release-deployer", {
					task: t`Deploy ${arg("releaseId")} in ${input("changeWindow")} after approval by ${input("approvedBy")}.`,
				}),
				transitions: { DEPLOYED: "done" },
			},
			cancelled: final(),
			done: final(),
		},
	});
}

export const gateStoryChart = gateStoryDefinition();
export const gateStoryScenario = storyScenario(gateStoryChart);
const gateAction = actionAt(gateStoryScenario.ast, "release-gate");
if (gateAction.kind !== "gate") {
	throw new Error("Expected release-gate to normalize as a gate action");
}
const deployAction = actionAt(gateStoryScenario.ast, "deploy");
const gatePayload = {
	requestLabel: "production deploy",
	releaseId: "release-2026.09.18",
	environment: "production",
	checks: ["typecheck", "unit", "storybook"],
};
const approvedOutput = {
	approvedBy: "release-control@surprisal.dev",
	changeWindow: "2026-09-18T16:00:00Z/2026-09-18T17:00:00Z",
	note: "All required checks are green.",
};

export const pendingGateSchedule: DurableLogRecord[] = [
	storyArgs({ releaseId: "release-2026.09.18", environment: "production" }, 1, startedAt + 1_000),
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "gate-story-session",
		actionUid: gateAction.uid,
		definition: gateAction,
		...stamp(2),
	},
	{
		type: "gate",
		kind: "opened",
		actionUid: gateAction.uid,
		phaseSeqId: 2,
		event: "release.approval-requested",
		payload: gatePayload,
		...(gateAction.reply === undefined ? {} : { reply: gateAction.reply }),
		...stamp(3),
	},
];

export const resolvedGateSchedule: DurableLogRecord[] = [
	...pendingGateSchedule,
	{
		type: "gate",
		kind: "resolved",
		gateSeqId: 3,
		actionUid: gateAction.uid,
		event: { type: "APPROVED", output: approvedOutput },
		...stamp(4),
	},
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "deploy-story-session",
		actionUid: deployAction.uid,
		definition: deployAction,
		input: {
			approvedBy: approvedOutput.approvedBy,
			changeWindow: approvedOutput.changeWindow,
		},
		...stamp(5),
	},
];

export const pendingGateRecords = capturedStorySchedule(gateStoryScenario.ast, pendingGateSchedule);
export const resolvedGateRecords = capturedStorySchedule(gateStoryScenario.ast, resolvedGateSchedule);

export const pendingGateRun = gateStoryScenario.runtimeRun(pendingGateRecords, {
	runId: "storybook:host-release-gate:pending",
	status: { state: "running", updatedAt: startedAt + 3_000 },
	cwd: "/workspace/release-control",
});

export const resolvedGateRun = gateStoryScenario.runtimeRun(resolvedGateRecords, {
	runId: "storybook:host-release-gate:resolved",
	status: { state: "running", updatedAt: startedAt + 7_000 },
	cwd: "/workspace/release-control",
});

export function gateContractChangedStoryRun() {
	const changed = storyScenario(gateStoryDefinition("emergency hotfix deploy"));
	const replay = explainReplay(changed.ast, pendingGateRecords);
	if (!replay.stale.some((entry) => entry.reason === "gate_contract_changed")) {
		throw new Error("Changed gate contract must produce gate_contract_changed replay diagnostics");
	}
	return hyperchartRunFromRuntime(changed.inspect, changed.ast, pendingGateRecords, {
		runId: "storybook:host-release-gate:contract-changed",
		status: { state: "stopped", updatedAt: startedAt + 4_000 },
		cwd: "/workspace/release-control",
	});
}

const PublishReply = z
	.object({
		releaseId: z.string(),
		artifactCount: z.number().int().nonnegative(),
		digest: z.string(),
		state: z
			.object({
				nested: z.object({ path: z.string(), optionalNote: z.string().optional() }).strict(),
				status: z.enum(["ready", "held"]),
			})
			.strict(),
		items: z.array(
			z
				.object({
					field: z.string(),
					priority: z.enum(["low", "high"]),
				})
				.strict(),
		),
	})
	.strict();

const PublishedPayload = z
	.object({
		release: z
			.object({
				environment: z.enum(["staging", "production"]),
				state: z
					.object({
						nestedPath: z.string(),
						status: z.enum(["ready", "held"]),
						note: z.string().optional(),
					})
					.strict(),
			})
			.strict(),
		entries: z.array(
			z.discriminatedUnion("type", [
				z.object({ type: z.literal("literal"), label: z.string(), note: z.string().optional() }).strict(),
				z.object({ type: z.literal("result"), label: z.string() }).strict(),
				z.object({ type: z.literal("input"), label: z.string() }).strict(),
				z.object({ type: z.literal("argument"), label: z.string() }).strict(),
				z.object({ type: z.literal("visit"), ordinal: z.number().int().positive() }).strict(),
			]),
		),
		metrics: z
			.object({
				attempts: z.number().int(),
				verified: z.boolean(),
				absent: z.null(),
			})
			.strict(),
	})
	.strict();

const MapPublishedPayload = z
	.object({
		mapKey: z.string(),
		item: z
			.object({
				field: z.string(),
				priority: z.enum(["low", "high"]),
			})
			.strict(),
		accepted: z.boolean(),
		environment: z.enum(["staging", "production"]),
		visit: z.number().int().positive(),
	})
	.strict();

export const emitStoryChart = chart({
	kind: "chart",
	id: "storybook-action-emits",
	args: {
		environment: {
			description: "Target environment included in emitted release facts.",
			schema: z.enum(["staging", "production"]),
			default: "production",
		},
	},
	initial: "publish",
	states: {
		publish: {
			kind: "state",
			input: {
				request: z.object({ path: z.string() }).strict().default({ path: "releases/2026.09.18" }),
			},
			action: agent("release-publisher", {
				task: "Publish the signed release bundle and report its immutable identity.",
				reply: PublishReply,
			}),
			emit: [
				emit({
					event: "release.published",
					payload: {
						release: {
							environment: arg("environment"),
							state: {
								nestedPath: result("publish", "state.nested.path"),
								status: result("publish", "state.status"),
							},
						},
						entries: [
							{ type: "literal", label: "signed" },
							{ type: "result", label: result("publish", "state.nested.path") },
							{ type: "input", label: input("request", "path") },
							{ type: "argument", label: arg("environment") },
							{ type: "visit", ordinal: visit() },
						],
						metrics: { attempts: 2, verified: true, absent: null },
					},
					schema: PublishedPayload,
				}),
				emit({
					event: "release.metrics-recorded",
					payload: {
						releaseId: result("publish", "releaseId"),
						artifactCount: result("publish", "artifactCount"),
					},
				}),
			],
			transitions: { PUBLISHED: "publish-map" },
		},
		"publish-map": map({
			over: result("publish", "items"),
			initial: "announce",
			onDone: "done",
			states: {
				announce: {
					kind: "state",
					action: agent("release-item-publisher", {
						task: t`Publish mapped release field ${item("field")}.`,
						reply: z.object({ accepted: z.boolean() }).strict(),
					}),
					emit: [
						emit({
							event: "release.item-published",
							payload: {
								mapKey: key(),
								item: { field: item("field"), priority: item("priority") },
								accepted: result("publish-map.announce", "accepted"),
								environment: arg("environment"),
								visit: visit(),
							},
							schema: MapPublishedPayload,
						}),
					],
					transitions: { PUBLISHED: "done" },
				},
				done: final(),
			},
		}),
		done: final(),
	},
});

export const emitStoryScenario = storyScenario(emitStoryChart);
const publishAction = actionAt(emitStoryScenario.ast, "publish");
const publishMapAction = actionAt(emitStoryScenario.ast, "publish-map.announce");
const publishedItem = { field: "manifest", priority: "high" };
const publishedEvent = {
	type: "PUBLISHED",
	output: {
		releaseId: "release-2026.09.18",
		artifactCount: 7,
		digest: "sha256:8ef177b6716a80d5578c63f07aa8f642",
		state: {
			nested: { path: "releases/2026.09.18/manifest.json", optionalNote: "signature verified" },
			status: "ready",
		},
		items: [publishedItem],
	},
};
export const emitStorySchedule: DurableLogRecord[] = [
	storyArgs({ environment: "production" }, 1, startedAt + 1_000),
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "emit-story-session",
		actionUid: publishAction.uid,
		definition: publishAction,
		...stamp(2),
	},
	{
		type: "state_action",
		kind: "complete",
		actionUid: publishAction.uid,
		event: publishedEvent,
		...stamp(3),
	},
];
const publishMapActionUid = { ...publishMapAction.uid, state: "publish-map#0.announce" };
export const mapEmitStorySchedule: DurableLogRecord[] = [
	...emitStorySchedule,
	{
		type: "spawned",
		path: "publish-map",
		instances: { "0": publishedItem },
		...stamp(4),
	},
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "map-emit-story-session",
		actionUid: publishMapActionUid,
		definition: publishMapAction,
		...stamp(5),
	},
	{
		type: "state_action",
		kind: "complete",
		actionUid: publishMapActionUid,
		event: { type: "PUBLISHED", output: { accepted: true } },
		...stamp(6),
	},
];

export const emitStoryRecords = capturedStorySchedule(emitStoryScenario.ast, emitStorySchedule);
export const emitStoryRun = emitStoryScenario.runtimeRun(emitStoryRecords, {
	runId: "storybook:action-emits",
	status: { state: "running", updatedAt: startedAt + 5_000 },
	cwd: "/workspace/releases",
});

export const mapEmitStoryRecords = capturedStorySchedule(emitStoryScenario.ast, mapEmitStorySchedule);
export const mapEmitStoryRun = emitStoryScenario.runtimeRun(mapEmitStoryRecords, {
	runId: "storybook:map-action-emits",
	status: { state: "complete", updatedAt: startedAt + 8_000 },
	cwd: "/workspace/releases",
});

export const validatedEmitStoryChart = chart({
	kind: "chart",
	id: "storybook-validated-action-emits",
	initial: "publish",
	states: {
		publish: {
			kind: "state",
			action: agent("validated-release-publisher", {
				task: "Publish only after the signed manifest passes the release policy guard.",
				reply: PublishReply,
				validation: {
					guard: tsImport("./guards/release-policy.ts", "validateReleasePolicy"),
					onFail: { nudge: 1, restart: 0 },
				},
			}),
			emit: [
				emit({
					event: "release.validated-publish",
					payload: {
						releaseId: result("publish", "releaseId"),
						digest: result("publish", "digest"),
					},
				}),
			],
			transitions: { PUBLISHED: "done" },
		},
		done: final(),
	},
});

export const validatedEmitStoryScenario = storyScenario(validatedEmitStoryChart);
const validatedPublishAction = actionAt(validatedEmitStoryScenario.ast, "publish");
export const validatedEmitStorySchedule: DurableLogRecord[] = [
	storyArgs({}, 1, startedAt + 1_000),
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "validated-emit-story-session",
		actionUid: validatedPublishAction.uid,
		definition: validatedPublishAction,
		...stamp(2),
	},
	{
		type: "state_action",
		kind: "complete",
		actionUid: validatedPublishAction.uid,
		event: publishedEvent,
		...stamp(3),
	},
	{
		type: "state_action",
		kind: "validated",
		actionUid: validatedPublishAction.uid,
		event: publishedEvent,
		guard:
			validatedPublishAction.kind === "agent" && validatedPublishAction.validation !== undefined
				? validatedPublishAction.validation.guard
				: tsImport("./guards/release-policy.ts", "validateReleasePolicy"),
		outcome: true,
		...stamp(4),
	},
];
export const validatedEmitStoryRecords = capturedStorySchedule(
	validatedEmitStoryScenario.ast,
	validatedEmitStorySchedule,
);
export const validatedEmitStoryRun = validatedEmitStoryScenario.runtimeRun(validatedEmitStoryRecords, {
	runId: "storybook:validated-action-emits",
	status: { state: "complete", updatedAt: startedAt + 6_000 },
	cwd: "/workspace/releases",
});
