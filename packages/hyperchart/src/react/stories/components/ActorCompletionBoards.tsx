import { useEffect, useState } from "react";
import { hyperchartSource } from "../../../core/source.js";
import type { HyperchartRunInfo } from "../../types.js";
import { captureCompletionStory, completionScenario } from "../../fixtures/completion-fixture.js";
import { callBatchResultScenario, captureCallBatchResultStory } from "../../fixtures/call-batch-result-fixture.js";
import { BoardSection } from "./BoardSection.js";
import { GraphTile } from "./GraphTile.js";
import { InspectorPanelTile } from "./InspectorPanelTile.js";
import { InteractiveInspector } from "../harnesses/InteractiveInspector.js";

type Snapshot = Parameters<typeof captureCompletionStory>[0];

function useCapturedRun(load: () => Promise<HyperchartRunInfo>, key: string) {
	const [run, setRun] = useState<HyperchartRunInfo>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let active = true;
		void load().then(
			(value) => { if (active) setRun(value); },
			(reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
		);
		return () => { active = false; };
	}, [key]);
	return { run, error };
}

function CompletionRuntimeCard({ snapshot, stateId, title }: { snapshot: Snapshot; stateId: string; title: string }) {
	const { run, error } = useCapturedRun(() => captureCompletionStory(snapshot), snapshot);
	if (error !== undefined) return <div role="alert">{error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating {title}…</div>;
	return <GraphTile title={title} run={run} visibleStateIds={[stateId]} height="h-[300px]" />;
}

/** Runtime variants within the existing Graph Card Atlas, not a separate Storybook section. */
export function CompletionRuntimeCards({ kind }: { kind: "notify" | "waitFor" }) {
	return kind === "notify" ? (
		<CompletionRuntimeCard snapshot="notification-retained" stateId="@worker.publish" title="notify · published" />
	) : (
		<>
			<CompletionRuntimeCard snapshot="notification-retained" stateId="wait" title="waitFor · notification retained" />
			<CompletionRuntimeCard snapshot="waiting" stateId="wait" title="waitFor · active wait" />
			<CompletionRuntimeCard snapshot="consumed" stateId="wait" title="waitFor · consumed" />
		</>
	);
}

export function CompletionRuntimePair() {
	const { run, error } = useCapturedRun(() => captureCompletionStory("consumed"), "consumed");
	if (error !== undefined) return <div role="alert">{error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating completion graph…</div>;
	return <GraphTile title="completion notify → waitFor · consumed" run={run} visibleStateIds={["@worker.publish", "wait"]} height="h-[480px]" />;
}

function ActorCompletionCase({ snapshot, stateId }: { snapshot: Snapshot; stateId: "@worker.publish" | "wait" }) {
	const { run, error } = useCapturedRun(() => captureCompletionStory(snapshot), snapshot);
	if (error !== undefined) return <div role="alert">{error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating completion fixture…</div>;
	const ast = completionScenario.ast;
	const label = stateId === "wait" ? "Wait For" : "Notify · @worker.publish";
	const phase = snapshot === "notify-in-flight" ? "sending"
		: snapshot === "notification-retained" ? stateId === "wait" ? "pending" : "published"
			: snapshot === "notify-failed" ? "failed"
				: snapshot === "waiting" ? "waiting" : "received";
	return <InspectorPanelTile variant="panel" title={`${label} · ${phase}`}
		description="Authored event contract and executed, replay-validated visit." run={run} selectedStateId={stateId}
		definitionSource={hyperchartSource(ast, stateId)}
		runtimeSources={[{ title: "Definition", code: hyperchartSource(ast, stateId), language: "typescript" }]} />;
}

export function CapturedActorDialog({ kind }: { kind: "completion" | "batch" }) {
	const { run, error } = useCapturedRun(
		kind === "completion" ? () => captureCompletionStory("consumed") : captureCallBatchResultStory,
		kind,
	);
	if (error !== undefined) return <div role="alert">{error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating actor fixture…</div>;
	return <InteractiveInspector runs={[run]} selectedRunId={run.runId} onClose={() => undefined} />;
}

function ActorBatchResultCase() {
	const { run, error } = useCapturedRun(captureCallBatchResultStory, "batch-result");
	if (error !== undefined) return <div role="alert">{error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating batch fixture…</div>;
	const ast = callBatchResultScenario.ast;
	return (
		<div className="grid gap-4 xl:grid-cols-2">
				{(["batch", "use"] as const).map((stateId) => (
					<InspectorPanelTile key={stateId} variant="panel" title={stateId === "batch" ? "callBatch" : "result(batch) consumer"}
						description="Executed durable visits and adapter-derived state details." run={run} selectedStateId={stateId}
						definitionSource={hyperchartSource(ast, stateId)}
						runtimeSources={[{ title: "Definition", code: hyperchartSource(ast, stateId), language: "typescript" }]} />
				))}
		</div>
	);
}

export function ActorCompletionCases() {
	return <>
		<BoardSection title="Notify · @worker.publish" description="Actual sending, published event with payload, and failed delivery.">
			<div className="space-y-5">
				{(["notify-in-flight", "notification-retained", "notify-failed"] as const).map((snapshot) => (
					<ActorCompletionCase key={snapshot} snapshot={snapshot} stateId="@worker.publish" />
				))}
			</div>
		</BoardSection>
		<BoardSection title="Wait For · root wait" description="Event signature, pending and active wait, then received payload.">
			<div className="space-y-5">
				{(["notification-retained", "waiting", "consumed"] as const).map((snapshot) => (
					<ActorCompletionCase key={snapshot} snapshot={snapshot} stateId="wait" />
				))}
			</div>
		</BoardSection>
	</>;
}

export function ActorRuntimeCases() {
	return <BoardSection title="Ordered callBatch result" description="Real execution-loop facts, replay validation, and production host projections.">
		<ActorBatchResultCase />
	</BoardSection>;
}
