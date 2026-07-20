import { useState } from "react";
import { HyperchartRunStrip } from "../../HyperchartRunStrip.js";
import { boardCharts, runStripRuns } from "../../fixtures/hyperchart-board-fixtures.js";
import { BoardPage } from "./BoardPage.js";
import { BoardSection } from "./BoardSection.js";

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
		</BoardPage>
	);
}
