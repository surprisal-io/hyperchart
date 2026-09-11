import {
	storyCaptureIdentity,
	storyCaptureKey,
} from "../../packages/hyperchart/src/react/fixtures/story-capture-key.js";
export const captures = new Map<string, DurableLogRecord[]>();
const identities = new Map<string, string>();
import { prepareUserInteractionResponseFromProjection } from "../../packages/hyperchart/src/execution/user_interaction.js";
import type { DurableLogRecord, DurableRecordDraft } from "../../packages/hyperchart/src/core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../packages/hyperchart/src/core/machine.js";
import { createBranchProjection, projectBranch } from "../../packages/hyperchart/src/core/projection.js";
import { explainReplay } from "../../packages/hyperchart/src/core/replay_check.js";
import type { ChartAst } from "../../packages/hyperchart/src/core/types.js";
import { loop } from "../../packages/hyperchart/src/execution/execution_loop.js";

/**
 * Recapture older scenario schedules through the execution loop. Input records are
 * used ONLY as scripted external responses and a snapshot stop selector: their
 * invokes, transitions, actor facts, provenance, and coordinates are never replayed
 * or copied into the captured log. Impossible schedules fail rather than fabricate
 * a visual state. New scenarios should script runtime effects directly.
 */
export async function captureStorySchedule(
	ast: ChartAst,
	schedule: readonly DurableLogRecord[],
): Promise<DurableLogRecord[]> {
	const records: DurableLogRecord[] = [];
	const effects: Effect[] = [];
	const queue: MachineEvent[] = [];
	const projection = createBranchProjection(ast);
	const boundary = new Error("captured story snapshot boundary");
	const key = (record: DurableLogRecord): string => {
		if (record.type === "state_action") {
			const state = ast.states[record.actionUid.state];
			const kind =
				record.kind === "complete" && state?.kind === "state" && state.action.kind === "user"
					? "resolved"
					: record.kind;
			return `${kind}:${record.actionUid.state}`;
		}
		if (record.type === "user_interaction") return `${record.kind}:${record.actionUid.state}`;
		if (record.type === "actor_created" || record.type === "actor_scope")
			return `${record.type}:${"kind" in record ? record.kind : ""}:${record.occurrence}`;
		if (record.type === "actor_message") return `${record.kind}:${record.occurrence}:${record.messageId}`;
		if (record.type === "actor_messages_enqueued")
			return `enqueued:${record.source.producerState}:${record.messages[0]?.producerVisit}`;
		if (record.type === "spawned") return `spawned:${record.path}`;
		return record.type;
	};
	const target = schedule.at(-1);
	if (target === undefined) return records;
	const targetKey = key(target);
	const required = new Map<string, number>();
	for (const record of schedule) required.set(key(record), (required.get(key(record)) ?? 0) + 1);
	const observed = new Map<string, number>();
	const reached = () => [...required].every(([kind, count]) => (observed.get(kind) ?? 0) >= count);
	const responses = schedule.filter(
		(record) =>
			(record.type === "state_action" && record.kind !== "invoke") ||
			record.type === "actor_created" ||
			record.type === "actor_messages_enqueued" ||
			(record.type === "actor_message" && record.kind === "replied") ||
			(record.type === "user_interaction" && record.kind === "resolved") ||
			record.type === "failure_intent",
	);
	const initialSeqId = (schedule[0]?.seqId ?? 1) - 1;
	let seqId = initialSeqId;
	const started = schedule[0]?.timestamp ?? 1_700_000_000_000;
	const append = (drafts: readonly DurableRecordDraft[]) =>
		drafts.map(
			(draft): DurableLogRecord => ({
				...draft,
				parentId: seqId === initialSeqId ? null : seqId,
				seqId: ++seqId,
				branchId: "main",
				timestamp: started + seqId * 1_000,
			}),
		);
	const retain = (added: readonly DurableLogRecord[]) => {
		for (const record of added) {
			records.push(record);
			observed.set(key(record), (observed.get(key(record)) ?? 0) + 1);
		}
		// A selector inside an atomic append rounds up to that append's committed
		// end. Stop before its acknowledgement (and any later effects), never in
		// the middle of persisted reply/settlement/resolution facts.
		if (reached()) throw boundary;
	};
	const initialArgs = schedule.find((record) => record.type === "args");
	try {
		const initial = append([{ type: "args", args: initialArgs?.type === "args" ? initialArgs.args : {} }]);
		retain(initial);
		projectBranch(projection, ast, initial);
		await loop(
			{
				branchId: "main",
				async runEffects(batch) {
					for (const effect of batch) {
						if (effect.kind === "durable_records") {
							const added = append(effect.records);
							retain(added);
							queue.push({ kind: "durable_records_added", effectId: effect.id, records: added });
						} else if (effect.kind !== "cancel") effects.push(effect);
					}
				},
				async *eventsQueue() {
					while (true) {
						if (queue.length > 0) {
							yield queue.shift()!;
							continue;
						}
						let emitted = false;
						for (const [index, response] of responses.entries()) {
							if (
								(response.type === "state_action" && response.kind === "complete") ||
								(response.type === "user_interaction" && response.kind === "resolved")
							) {
								const gate = Object.values(projection.openUserInteractions).find(
									(entry) => entry.opened.actionUid.state === response.actionUid.state,
								)?.opened;
								if (gate !== undefined) {
									const draft = await prepareUserInteractionResponseFromProjection(projection, "main", gate, {
										ast,
										gateSeqId: gate.seqId,
										event: response.event,
									});
									const added = append([draft]);
									retain(added);
									responses.splice(index, 1);
									yield { kind: "durable_records_added", effectId: `user:${gate.seqId}`, records: added };
									emitted = true;
									break;
								}
							}
							const effectIndex = effects.findIndex((effect) => {
								if (response.type === "failure_intent")
									return (
										"actionUid" in effect &&
										effect.actionUid.state === response.origin &&
										["agent", "script", "tsImport"].includes(effect.kind)
									);
								if (response.type === "state_action") {
									if (!("actionUid" in effect) || effect.actionUid.state !== response.actionUid.state) return false;
									return response.kind === "complete"
										? ["agent", "script", "tsImport"].includes(effect.kind)
										: response.kind === "validated"
											? effect.kind === "validate"
											: effect.kind === "timer";
								}
								if (response.type === "actor_created")
									return effect.kind === "actor_create" && effect.occurrence === response.occurrence;
								if (response.type === "actor_messages_enqueued")
									return (
										effect.kind === "actor_enqueue" && effect.source.producerState === response.source.producerState
									);
								return (
									response.type === "actor_message" &&
									effect.kind === "actor_reply" &&
									effect.occurrence === response.occurrence &&
									effect.messageId === response.messageId
								);
							});
							if (effectIndex < 0) continue;
							const effect = effects.splice(effectIndex, 1)[0]!;
							responses.splice(index, 1);
							if (response.type === "failure_intent") {
								if (effect.kind === "agent")
									yield {
										kind: "agent",
										effectId: effect.id,
										outcome: {
											kind: "failed",
											failure: { kind: "explicit", retryable: false, message: String(response.error) },
										},
									};
								else if (effect.kind === "script" || effect.kind === "tsImport")
									yield {
										kind: effect.kind,
										effectId: effect.id,
										event: { type: "FAILED", error: String(response.error) },
									};
							} else if (response.type === "state_action") {
								if (response.kind === "complete") {
									if (effect.kind === "agent")
										yield {
											kind: "agent",
											effectId: effect.id,
											outcome: {
												kind: "completed",
												event: response.event,
												...(response.artifacts === undefined ? {} : { artifacts: response.artifacts }),
											},
										};
									else if (effect.kind === "script" || effect.kind === "tsImport")
										yield {
											kind: effect.kind,
											effectId: effect.id,
											event: response.event,
											...(response.artifacts === undefined ? {} : { artifacts: response.artifacts }),
										};
								} else if (response.kind === "validated")
									yield { kind: "validated", effectId: effect.id, outcome: response.outcome };
								else if (response.kind === "timer_fired") yield { kind: "timer", effectId: effect.id };
							} else
								yield {
									kind: "actor_effect",
									effectId: effect.id,
									operation:
										effect.kind === "actor_create" ? "create" : effect.kind === "actor_enqueue" ? "enqueue" : "reply",
									ok: true,
								};
							emitted = true;
							break;
						}
						if (!emitted)
							throw new Error(
								`Story ${ast.id} cannot execute scheduled snapshot ${targetKey}; awaiting ${effects.map((effect) => effect.kind + ("actionUid" in effect ? `:${effect.actionUid.state}` : "")).join(", ")}; remaining responses ${responses.map(key).join(", ")}; captured ${records.map(key).join(", ")}`,
							);
					}
				},
			},
			{ machineState: () => createMachine(ast, projection) },
		);
	} catch (error) {
		if (error !== boundary) throw error;
	}
	if (!reached()) throw new Error(`Story ${ast.id} terminated before snapshot ${targetKey}`);
	const replay = explainReplay(ast, records);
	if (replay.broken !== undefined || replay.skipped.length > 0 || replay.stale.length > 0)
		throw new Error(`Captured story ${ast.id} does not replay: ${JSON.stringify(replay)}`);
	const captureKey = storyCaptureKey(ast, schedule);
	const identity = storyCaptureIdentity(ast, schedule);
	if (identities.has(captureKey) && identities.get(captureKey) !== identity)
		throw new Error(`Story capture key collision: ${captureKey}`);
	identities.set(captureKey, identity);
	captures.set(captureKey, records);
	return records;
}
