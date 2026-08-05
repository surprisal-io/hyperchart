import {
	CodeBracketSquareIcon,
	CommandLineIcon,
	InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { HyperchartRunInfo } from "../../../types.js";
import {
	formatHyperchartDateTime,
	formatHyperchartUsage,
} from "../../../hyperchart-display.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { Section } from "../ui/Section.js";
import { IssuesSection } from "../validation/IssuesSection.js";
import { DefinitionSection } from "./DefinitionSection.js";

export function RunOverview({ run, definitionSource }: { run: HyperchartRunInfo; definitionSource?: string }) {
	return (
		<div className="space-y-3">
			{run.mode === "static" ? (
				<Section title="Static graph" icon={InformationCircleIcon}>
					<div className="text-[var(--text-muted)]">
						This is a static chart inspect. Runtime arguments, process metadata, timings, and resolved fan-out data are
						available only for run inspect.
					</div>
				</Section>
			) : (
				<>
					<Section title="Run arguments" icon={CodeBracketSquareIcon}>
						<JsonBlock value={run.args} />
					</Section>
					<Section title="Run metadata" icon={InformationCircleIcon}>
						<dl className="grid gap-2 text-[11px]">
							<div>
								<dt className="text-[var(--text-muted)]">run id</dt>
								<dd className="break-all font-mono">{run.runId}</dd>
							</div>
							<div>
								<dt className="text-[var(--text-muted)]">cwd</dt>
								<dd className="break-all">{run.cwd || "—"}</dd>
							</div>
							<div>
								<dt className="text-[var(--text-muted)]">created</dt>
								<dd>{formatHyperchartDateTime(run.createdAt)}</dd>
							</div>
							<div>
								<dt className="text-[var(--text-muted)]">updated</dt>
								<dd>{formatHyperchartDateTime(run.updatedAt)}</dd>
							</div>
							<div>
								<dt className="text-[var(--text-muted)]">pid</dt>
								<dd>{run.pid ?? "—"}</dd>
							</div>
							<div>
								<dt className="text-[var(--text-muted)]">detached</dt>
								<dd>{run.detached ? "yes" : "no"}</dd>
							</div>
						</dl>
						{run.totalUsage && (
							<div className="rounded-lg bg-[var(--bg-tertiary)] p-2 text-[11px]">
								usage: {formatHyperchartUsage(run.totalUsage) ?? JSON.stringify(run.totalUsage)}
							</div>
						)}
					</Section>
					<IssuesSection issues={run.issues} />
				</>
			)}
			{run.finalOutput && (
				<Section title="Final output" icon={CommandLineIcon} defaultOpen={false}>
					<ExpandablePre collapsedLines={14}>{run.finalOutput}</ExpandablePre>
				</Section>
			)}
			{definitionSource && <DefinitionSection source={definitionSource} />}
		</div>
	);
}
