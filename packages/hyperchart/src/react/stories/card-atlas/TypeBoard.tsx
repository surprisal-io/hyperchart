import type { HyperchartStateType } from "../../types.js";
import { BoardPage, GraphTile } from "../components/index.js";
import { atlasCases } from "./catalog.js";
import { AtlasRuntimeCards } from "./runtime-cards.js";

export function TypeBoard({ kind }: { kind: HyperchartStateType }) {
	const cases = atlasCases(kind);
	return (
		<BoardPage
			title={`Card Atlas · ${kind}`}
			description="Реально достижимые варианты этого типа из нормализованных definitions и replay-valid execution logs, переданные через production host adapter."
		>
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
				{cases.map(({ title, run, stateId, status }) => (
					<GraphTile
						key={`${run.runId}:${stateId}:${title}`}
						title={`${status} · ${title}`}
						run={run}
						visibleStateIds={[stateId]}
						height="h-[300px]"
					/>
				))}
				<AtlasRuntimeCards kind={kind} />
				{(kind === "notify" || kind === "waitFor") && (
					<div className="col-span-full text-xs text-[var(--text-secondary)]">
						Notify / Wait For State Details:{" "}
						<a
							className="underline"
							href="/?path=/story/hyperchart-visual-tests-inspector-panel-actors--notify-and-wait-for"
						>
							contract, runtime, and visit history
						</a>
					</div>
				)}
			</div>
		</BoardPage>
	);
}
