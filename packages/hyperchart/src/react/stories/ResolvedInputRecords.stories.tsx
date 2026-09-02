import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { z } from "zod";
import { agent, chart, final, input, result, t, user } from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
import { createBranchProjection, projectBranch, type BranchProjection } from "../../core/projection.js";
import type { ChartAst } from "../../core/types.js";
import { loop } from "../../execution/execution_loop.js";
import type { Runtime } from "../../runtime/runtime.js";
import { RuntimeSection } from "../components/inspector/details/RuntimeSection.js";
import type { HyperchartRunInfo, HyperchartStateInfo } from "../types.js";
import { actionAt, storyScenario, type StoryScenario } from "../fixtures/story-scenario.js";

const Decision = z.object({ hypothesisId: z.string() });
const Candidate = z.object({ decision: Decision });
const ResolvedInput = z.object({ hypothesisId: z.string() });
const now = Date.UTC(2026, 7, 31, 19, 0, 0);
const stamp = (seqId: number) => ({
	seqId,
	parentId: seqId === 1 ? null : seqId - 1,
	branchId: "main",
	timestamp: now + seqId * 1_000,
});

const recordedScenario = storyScenario(chart({
	kind: "chart",
	id: "resolved-input-records",
	initial: "produce",
	states: {
		produce: {
			kind: "state",
			action: agent("candidate-producer", { reply: Candidate }),
			transitions: {
				GENERATED: {
					target: "review",
					input: { hypothesisId: result("produce", "decision.hypothesisId") },
				},
			},
		},
		review: {
			kind: "state",
			input: { hypothesisId: z.string() },
			action: user({
				prompt: t`Review ${input("hypothesisId")}`,
				options: ["SELECTED"],
			}),
			transitions: {
				SELECTED: {
					target: "execute",
					input: { hypothesisId: result("produce", "decision.hypothesisId") },
				},
			},
		},
		execute: {
			kind: "state",
			input: { hypothesisId: z.string() },
			action: agent("experimenter", { task: t`Execute ${input("hypothesisId")}` }),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
}));

const hypothesisId = "hypothesis:42";
const stateActionScenario = storyScenario(chart({
	kind: "chart",
	id: "resolved-state-action-input",
	initial: "produce",
	states: {
		produce: {
			kind: "state",
			action: agent("candidate-producer", { reply: Candidate }),
			transitions: {
				GENERATED: { target: "execute", input: { hypothesisId: result("produce", "decision.hypothesisId") } },
			},
		},
		execute: {
			kind: "state",
			input: { hypothesisId: z.string() },
			action: agent("experimenter", { task: t`Execute ${input("hypothesisId")}` }),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
}));

class CaptureFinished extends Error {}

class ResolvedInputCaptureRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	readonly projection: BranchProjection;
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;

	constructor(readonly ast: ChartAst, private readonly stopAt: (record: DurableLogRecord) => boolean) {
		this.projection = createBranchProjection(ast);
	}
	async loadAst() { return this.ast; }
	async loadProjection() { return this.projection; }
	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				const records = effect.records.map((draft): DurableLogRecord => ({
					...draft,
					seqId: ++this.seqId,
					parentId: this.seqId === 1 ? null : this.seqId - 1,
					branchId: "main",
					timestamp: now + this.seqId * 1_000,
				}) as DurableLogRecord);
				this.records.push(...records);
				if (effect.id === "args") projectBranch(this.projection, this.ast, records);
				if (records.some(this.stopAt)) throw new CaptureFinished();
				this.push({ kind: "durable_records_added", effectId: effect.id, records });
			} else if (effect.kind === "agent") {
				this.push({ kind: "agent", effectId: effect.id, event: effect.actionUid.state === "produce"
					? { type: "GENERATED", output: { decision: { hypothesisId } } }
					: { type: "DONE" } });
			} else if (effect.kind !== "cancel") {
				throw new Error(`Unexpected resolved-input story effect ${effect.kind}`);
			}
		}
	}
	async *eventsQueue(): AsyncIterable<MachineEvent> {
		while (true) {
			if (this.queued.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
			const event = this.queued.shift();
			if (event !== undefined) yield event;
		}
	}
	private push(event: MachineEvent) { this.queued.push(event); this.waiters.shift()?.(); }
}

async function captureExecutedRun(
	scenario: StoryScenario,
	stopAt: (record: DurableLogRecord) => boolean,
	options: Parameters<StoryScenario["runtimeRun"]>[1],
): Promise<HyperchartRunInfo> {
	const runtime = new ResolvedInputCaptureRuntime(scenario.ast, stopAt);
	await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: {} }] }]);
	try {
		await loop(runtime, { machineState: () => createMachine(scenario.ast, structuredClone(runtime.projection)) });
	} catch (error) {
		if (!(error instanceof CaptureFinished)) throw error;
	}
	return scenario.runtimeRun(runtime.records, options);
}

type ExecutedRuns = Readonly<{ gate: HyperchartRunInfo; stateAction: HyperchartRunInfo }>;
let executedRunsPromise: Promise<ExecutedRuns> | undefined;
function executedRuns(): Promise<ExecutedRuns> {
	executedRunsPromise ??= Promise.all([
		captureExecutedRun(
			recordedScenario,
			(record) => record.type === "user_interaction" && record.kind === "opened",
			{ runId: "resolved-input:opened", status: { state: "blocked", updatedAt: now + 5_000 }, cwd: "/workspace" },
		),
		captureExecutedRun(
			stateActionScenario,
			(record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "execute",
			{ runId: "resolved-input:state-action", status: { state: "running", updatedAt: now + 5_000 }, cwd: "/workspace" },
		),
	]).then(([gate, stateAction]) => ({ gate, stateAction }));
	return executedRunsPromise;
}

const plainScenario = storyScenario(chart({
	kind: "chart",
	id: "records-without-input",
	initial: "approval",
	states: {
		approval: {
			kind: "state",
			action: user({ prompt: "Continue?", options: ["CONTINUE"] }),
			transitions: { CONTINUE: "work" },
		},
		work: {
			kind: "state",
			action: agent("worker", { task: "Continue without state input." }),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
}));
const approval = actionAt(plainScenario.ast, "approval");
const work = actionAt(plainScenario.ast, "work");
const plainPrefix: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	{ type: "state_action", kind: "invoke", sessionId: "approval-session", actionUid: approval.uid, definition: approval, ...stamp(2) },
	{ type: "user_interaction", kind: "opened", actionUid: approval.uid, phaseSeqId: 2, prompt: "Continue?", options: ["CONTINUE"], events: ["CONTINUE"], ...stamp(3) },
];
const plainUserRun = plainScenario.runtimeRun(plainPrefix, {
	runId: "resolved-input:opened-absent",
	status: { state: "blocked", updatedAt: now + 3_000 },
	cwd: "/workspace",
});
const plainStateRun = plainScenario.runtimeRun([
	...plainPrefix,
	{ type: "user_interaction", kind: "resolved", gateSeqId: 3, actionUid: approval.uid, event: { type: "CONTINUE" }, ...stamp(4) },
	{ type: "state_action", kind: "invoke", sessionId: "work-session", actionUid: work.uid, definition: work, ...stamp(5) },
], {
	runId: "resolved-input:state-action-absent",
	status: { state: "running", updatedAt: now + 5_000 },
	cwd: "/workspace",
});

function stateFrom(run: HyperchartRunInfo, stateId: string): HyperchartStateInfo {
	const state = run.states.find((candidate) => candidate.id === stateId);
	if (state === undefined) throw new Error(`story state is unavailable: ${stateId}`);
	return state;
}

type InputPanel = Readonly<{
	label: string;
	description: string;
	run: HyperchartRunInfo;
	state: string;
}>;

const legacyPanels: readonly InputPanel[] = [
	{
		label: "legacy compatibility fixture · user_interaction/opened · input absent",
		description: "Hand-authored pre-input durable shape, replay-checked through the production adapter to demonstrate old-log presentation.",
		run: plainUserRun,
		state: "approval",
	},
	{
		label: "legacy compatibility fixture · state_action/invoke · input absent",
		description: "Hand-authored pre-input durable shape, replay-checked through the production adapter to retain the prior compact detail view.",
		run: plainStateRun,
		state: "work",
	},
];

function RecordInputBoard() {
	const [captured, setCaptured] = useState<ExecutedRuns>();
	useEffect(() => {
		let current = true;
		void executedRuns().then((runs) => { if (current) setCaptured(runs); });
		return () => { current = false; };
	}, []);
	const panels: readonly InputPanel[] = [
		...(captured === undefined ? [] : [
			{
				label: "executed capture · user_interaction/opened · input recorded",
				description: "The production execution loop emitted an opened gate carrying the fully resolved hypothesis input.",
				run: captured.gate,
				state: "review",
			},
			{
				label: "executed capture · state_action/invoke · result-ref input recorded",
				description: "The production execution loop resolved result(\"produce\", \"decision.hypothesisId\") before invoking the target action.",
				run: captured.stateAction,
				state: "execute",
			},
		] satisfies readonly InputPanel[]),
		...legacyPanels,
	];
	return (
		<main className="min-h-screen bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]">
			<div className="mx-auto max-w-6xl">
				<h1 className="text-lg font-semibold">Durable resolved input records</h1>
				<p className="mt-1 text-xs text-[var(--text-tertiary)]">
					Executed production-loop captures for input-present records, contrasted with explicitly labeled legacy compatibility fixtures.
				</p>
				{captured === undefined ? <p className="mt-4 text-xs text-[var(--text-tertiary)]">Capturing executed durable records…</p> : null}
				<div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
					{panels.map((panel) => {
						const state = stateFrom(panel.run, panel.state);
						return (
							<section key={panel.label} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
								<h2 className="font-mono text-xs font-semibold text-[var(--hc-blue-text)]">{panel.label}</h2>
								<p className="mb-3 mt-1 text-[11px] text-[var(--text-tertiary)]">{panel.description}</p>
								<RuntimeSection state={state} allStates={panel.run.states} />
							</section>
						);
					})}
				</div>
			</div>
		</main>
	);
}

const meta = {
	title: "Hyperchart/Inspector/Resolved Input Records",
	id: "hyperchart-inspector-resolved-input-records",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: {
			description: {
				component: "Execution-loop-captured user-interaction and state-action inputs rendered as structured JSON, with explicitly labeled legacy absent-field fixtures.",
			},
		},
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const RecordShapes: Story = {
	render: () => <RecordInputBoard />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findAllByText("resolved inputs")).toHaveLength(2);
		await expect(canvas.getByText("executed capture · state_action/invoke · result-ref input recorded")).toBeVisible();
	},
};
