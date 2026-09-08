import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartRunInfo } from "../types.js";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { captureExecutionBoardRun } from "../fixtures/execution-board-fixture.js";

function ExecutedFixtureBoard() {
	const [run, setRun] = useState<HyperchartRunInfo>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let current = true;
		void captureExecutionBoardRun().then(
			(value) => { if (current) setRun(value); },
			(reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); },
		);
		return () => { current = false; };
	}, []);
	if (error !== undefined) return <div className="p-6 text-sm text-red-400">{error}</div>;
	if (run === undefined) return <div className="grid min-h-screen place-items-center bg-[var(--bg-primary)] text-sm text-[var(--text-muted)]">Executing fixture and replay-validating its durable log…</div>;
	return <HyperchartInspectorDialog runs={[run]} onClose={() => undefined} embedded initialCanvasMode="execution" />;
}

const meta = {
	title: "Hyperchart/Inspector/Execution",
	component: ExecutedFixtureBoard,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ExecutedFixtureBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteExecutionBoard: Story = {
	name: "Executed Log · Complete Board",
	parameters: {
		docs: {
			description: {
				story: "Rendered directly from a chart executed by the real execution loop, replay-validated durable records, and the production host adapter.",
			},
		},
	},
};
