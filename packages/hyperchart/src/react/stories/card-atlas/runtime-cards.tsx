import { useEffect, useState } from "react";
import type { HyperchartRunInfo, HyperchartStateType } from "../../types.js";
import { captureCallBatchResultStory, captureSingletonCallStory } from "../../fixtures/call-batch-result-fixture.js";
import { captureCompletionStory } from "../../fixtures/completion-fixture.js";
import { captureExecutionBoardRun } from "../../fixtures/execution-board-fixture.js";
import { captureAtlasStatus } from "../../fixtures/atlas-status-fixtures.js";
import { GraphTile } from "../components/GraphTile.js";

type Loader = () => Promise<HyperchartRunInfo>;
function ExecutedCard({ title, stateId, load }: { title: string; stateId: string; load: Loader }) {
	const [run, setRun] = useState<HyperchartRunInfo>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let active = true;
		void load().then(
			(value) => { if (active) setRun(value); },
			(reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
		);
		return () => { active = false; };
	}, [load]);
	if (error !== undefined) return <div role="alert">{title}: {error}</div>;
	if (run === undefined) return <div role="status">Executing and replay-validating {title}…</div>;
	return <GraphTile title={title} run={run} visibleStateIds={[stateId]} height="h-[300px]" />;
}

const notifyInFlight = () => captureCompletionStory("notify-in-flight");
const notifyFailed = () => captureCompletionStory("notify-failed");
const notifyPublished = () => captureCompletionStory("notification-retained");
const waitActive = () => captureCompletionStory("waiting");
const waitDone = () => captureCompletionStory("consumed");
const compoundDone = () => captureAtlasStatus("compound-done");
const functionRunning = () => captureAtlasStatus("function-running");
const functionFailed = () => captureAtlasStatus("function-failed");

/** Only add executed cases for statuses absent from the static/recorded atlas catalog. */
export function AtlasRuntimeCards({ kind }: { kind: HyperchartStateType }) {
	switch (kind) {
		case "notify":
			return <>
				<ExecutedCard title="notify · validating" stateId="@worker.publish" load={notifyInFlight} />
				<ExecutedCard title="notify · published" stateId="@worker.publish" load={notifyPublished} />
				<ExecutedCard title="notify · failed delivery" stateId="@worker.publish" load={notifyFailed} />
			</>;
		case "waitFor":
			return <>
				<ExecutedCard title="waitFor · waiting" stateId="wait" load={waitActive} />
				<ExecutedCard title="waitFor · consumed" stateId="wait" load={waitDone} />
			</>;
		case "call":
			return <ExecutedCard title="call · resolved reply" stateId="request" load={captureSingletonCallStory} />;
		case "callBatch":
			return <ExecutedCard title="callBatch · completed ordered result" stateId="batch" load={captureCallBatchResultStory} />;
		case "tsImport":
			return <>
				<ExecutedCard title="Function action · running" stateId="execute" load={functionRunning} />
				<ExecutedCard title="Function action · completed" stateId="score" load={captureExecutionBoardRun} />
				<ExecutedCard title="Function action · failed" stateId="execute" load={functionFailed} />
			</>;
		case "compound":
			return <ExecutedCard title="Compound scope · completed" stateId="scope" load={compoundDone} />;
		default:
			return null;
	}
}
