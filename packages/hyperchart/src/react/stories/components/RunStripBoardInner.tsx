import { useState } from "react";
import { HyperchartRunStrip } from "../../HyperchartRunStrip.js";
import type { HyperchartRunSummaryInfo } from "../../types.js";
import { boardCharts, runStripRuns } from "../../fixtures/hyperchart-board-fixtures.js";
import { BoardPage } from "./BoardPage.js";
import { BoardSection } from "./BoardSection.js";

const summaryRunBase = {
	chartName: "summary-only",
	cwd: "/Users/demo/Work/pi-hyperchart",
	createdAt: Date.UTC(2026, 6, 7, 22, 30, 0),
	updatedAt: Date.UTC(2026, 6, 7, 22, 45, 0),
} satisfies Omit<HyperchartRunSummaryInfo, "runId" | "status">;

const summaryProgressStates: HyperchartRunSummaryInfo[] = [
	{
		...summaryRunBase,
		runId: "summary-progress-omitted",
		status: "running",
		activeState: "deploy",
	},
	{
		...summaryRunBase,
		runId: "summary-progress-partial",
		status: "blocked",
		progressPercent: 40,
	},
	{
		...summaryRunBase,
		runId: "summary-progress-complete",
		status: "running",
		progressDone: 2,
		progressTotal: 5,
		progressPercent: 40,
	},
];

export function RunStripBoardInner() {
	const [selectedRunId, setSelectedRunId] = useState<string | null>(runStripRuns[0]?.runId ?? null);
	return (
		<BoardPage
			title="Run strip states"
			description="Только состояния верхнего HyperchartRunStrip: running, completed, blocked, failed, paused, definitions-only и действия strip. Карточки state-нод проверяются отдельно в Card Atlas."
		>
			<BoardSection title="Run strip with all run statuses">
				<HyperchartRunStrip
					hypercharts={boardCharts}
					runs={runStripRuns}
					selectedRunId={selectedRunId}
					onSelectRun={setSelectedRunId}
					onRun={() => undefined}
					onOpenDefinition={() => undefined}
					onResume={() => undefined}
					onAbort={() => undefined}
					onOpenInspector={(runId) => setSelectedRunId(runId ?? null)}
				/>
			</BoardSection>
			{summaryProgressStates.map((run) => (
				<BoardSection key={run.runId} title={run.runId.replaceAll("-", " ")}>
					<HyperchartRunStrip hypercharts={[]} runs={[run]} />
				</BoardSection>
			))}
		</BoardPage>
	);
}
