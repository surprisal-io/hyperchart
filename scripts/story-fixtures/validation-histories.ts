import type {
	ArtifactPin,
	DurableLogRecord,
	DurableRecordDraft,
} from "../../packages/hyperchart/src/core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../packages/hyperchart/src/core/machine.js";
import {
	createBranchProjection,
	projectBranch,
	type BranchProjection,
} from "../../packages/hyperchart/src/core/projection.js";
import { explainReplay } from "../../packages/hyperchart/src/core/replay_check.js";
import { loop } from "../../packages/hyperchart/src/execution/execution_loop.js";
import {
	guardedValidationScenario,
	removedValidationScenario,
} from "../../packages/hyperchart/src/react/fixtures/removed-validator-fixture.js";
import {
	originalReplayScenario,
	changedReplayScenario,
} from "../../packages/hyperchart/src/react/fixtures/replay-incompatible-fixture.js";

/** Execute rejection, acceptance/re-entry, and another acceptance through the real loop. */
export async function captureRemovedValidatorHistory(
	append: (drafts: readonly DurableRecordDraft[]) => Promise<readonly DurableLogRecord[]>,
	options: {
		branchId?: string;
		unguarded?: boolean;
		projection?: BranchProjection;
		pins?: readonly ArtifactPin[];
	} = {},
) {
	const ast = options.unguarded ? removedValidationScenario.ast : guardedValidationScenario.ast;
	const records: DurableLogRecord[] = [];
	const queue: MachineEvent[] = [];
	const initial = options.projection === undefined ? await append([{ type: "args", args: {} }]) : [];
	records.push(...initial);
	const projection = options.projection ?? projectBranch(createBranchProjection(ast), ast, initial);
	let attempts = 0;
	let verdicts = 0;
	const completion = (effect: Extract<Effect, { kind: "agent" }>) => {
		const pin = options.pins?.[attempts];
		const event = { type: options.unguarded || attempts >= 2 ? "DONE" : "AGAIN", output: { attempt: ++attempts } };
		queue.push({
			kind: "agent",
			effectId: effect.id,
			outcome: { kind: "completed", event, ...(pin === undefined ? {} : { artifacts: { "result.txt": pin } }) },
		});
	};
	const state = await loop(
		{
			branchId: options.branchId ?? "main",
			async runEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "durable_records") {
						const added = await append(effect.records);
						records.push(...added);
						queue.push({ kind: "durable_records_added", effectId: effect.id, records: added });
					} else if (effect.kind === "agent") completion(effect);
					else if (effect.kind === "validate")
						queue.push({
							kind: "validated",
							effectId: effect.id,
							outcome: ++verdicts === 1 ? { ok: false, reason: "candidate rejected" } : true,
						});
					else if (effect.kind !== "cancel") throw new Error(`Unexpected validation fixture effect ${effect.kind}`);
				}
			},
			async *eventsQueue() {
				while (queue.length > 0) yield queue.shift()!;
			},
		},
		{ machineState: () => createMachine(ast, projection) },
	);
	return { records, state };
}

/** Capture real execution-loop output, with rejected retry and a pageable post-break suffix. */
export async function captureReplayIncompatibleHistory(
	append: (drafts: readonly DurableRecordDraft[]) => Promise<readonly DurableLogRecord[]>,
	suffixArtifacts?: Readonly<Record<string, ArtifactPin>>,
) {
	const ast = originalReplayScenario.ast;
	const records: DurableLogRecord[] = [];
	const queue: MachineEvent[] = [];
	let validations = 0;
	let subsequentVisits = 0;
	let clockEffectId: string | undefined;
	let suffixValidationEffectId: string | undefined;
	const args = await append([{ type: "args", args: { topic: "durable evidence" } }]);
	records.push(...args);
	const projection = projectBranch(createBranchProjection(ast), ast, args);
	await loop(
		{
			branchId: "main",
			async runEffects(effects: Effect[]) {
				for (const effect of effects) {
					if (effect.kind === "durable_records") {
						const added = await append(effect.records);
						records.push(...added);
						queue.push({ kind: "durable_records_added", effectId: effect.id, records: added });
						// The clock completion provides a durable snapshot boundary later than
						// the candidate claim, while its first validation is still pending.
						if (
							added.some(
								(record) =>
									record.type === "state_action" &&
									record.kind === "complete" &&
									record.actionUid.state === "suffix.clock.work",
							)
						) {
							if (suffixValidationEffectId === undefined) throw new Error("Suffix validation must be pending");
							queue.push({ kind: "validated", effectId: suffixValidationEffectId, outcome: true });
						}
					} else if (effect.kind === "agent") {
						if (effect.actionUid.state === "suffix.clock.work") {
							clockEffectId = effect.id;
							continue;
						}
						const event = effect.actionUid.state === "after" && ++subsequentVisits < 55 ? "AGAIN" : "DONE";
						queue.push({
							kind: "agent",
							effectId: effect.id,
							outcome: {
								kind: "completed",
								event: { type: event },
								...(effect.actionUid.state === "suffix.guarded.work" && suffixArtifacts !== undefined
									? { artifacts: suffixArtifacts }
									: {}),
							},
						});
					} else if (effect.kind === "script" || effect.kind === "tsImport") {
						queue.push({ kind: effect.kind, effectId: effect.id, event: { type: "DONE" } });
					} else if (effect.kind === "validate") {
						if (effect.actionUid.state === "suffix.guarded.work") {
							suffixValidationEffectId = effect.id;
							if (clockEffectId === undefined) throw new Error("Clock must be invoked before suffix validation");
							queue.push({
								kind: "agent",
								effectId: clockEffectId,
								outcome: { kind: "completed", event: { type: "DONE" } },
							});
							continue;
						}
						queue.push({
							kind: "validated",
							effectId: effect.id,
							outcome: ++validations === 1 ? { ok: false, reason: "record lab notes and retry" } : true,
						});
					} else if (effect.kind !== "cancel") throw new Error(`Unexpected replay fixture effect ${effect.kind}`);
				}
			},
			async *eventsQueue() {
				while (queue.length > 0) yield queue.shift()!;
			},
		},
		{ machineState: () => createMachine(ast, projection) },
	);
	const original = explainReplay(ast, records);
	if (original.broken !== undefined || original.stale.length > 0 || original.skipped.length > 0)
		throw new Error("Captured history must replay with its original chart");
	const broken = explainReplay(changedReplayScenario.ast, records).broken;
	if (broken === undefined) throw new Error("Changed action identity must break replay");
	return { records, broken };
}
