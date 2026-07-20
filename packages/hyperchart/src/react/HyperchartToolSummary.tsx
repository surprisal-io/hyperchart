import { lazy, Suspense, useMemo, useState } from "react";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { hyperchartRunFromToolDetails } from "../host/index.js";
import type { HyperchartRunInfo } from "../host/index.js";
import { formatHyperchartUsage, runningHyperchartStates } from "./hyperchart-display.js";

const HyperchartInspectorDialog = lazy(async () => {
	const module = await import("./HyperchartInspectorDialog.js");
	return { default: module.HyperchartInspectorDialog };
});

export interface HyperchartToolSummaryProps {
	toolName: string;
	args?: Record<string, unknown>;
	status: "running" | "done" | "error" | string;
	details?: unknown;
	runs?: HyperchartRunInfo[];
	onOpenRun?: (runId: string) => void;
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function chartNameFromArgs(args?: Record<string, unknown>): string | undefined {
	const chartPath = stringArg(args?.chartPath);
	return (
		stringArg(args?.chartName) ??
		chartPath
			?.split(/[\\/]/)
			.pop()
			?.replace(/\.chart\.[jt]s$/, "")
			.replace(/\.[jt]s$/, "")
	);
}

function persistedRun(
	args: Record<string, unknown> | undefined,
	runs: HyperchartRunInfo[],
): HyperchartRunInfo | undefined {
	const runId = stringArg(args?.runId) ?? stringArg(args?.runDir);
	if (runId) {
		const byId = runs.find((run) => run.runId === runId || runId.endsWith(`/${run.runId}`));
		if (byId) return byId;
	}
	const chartName = chartNameFromArgs(args);
	if (chartName) {
		return (
			runs.find((run) => run.chartName === chartName && run.status === "running") ??
			runs.find((run) => run.chartName === chartName)
		);
	}
	return runs.find((run) => run.status === "running") ?? runs[0];
}

function actionLabel(toolName: string, args?: Record<string, unknown>): string {
	if (toolName !== "hyperchart") return toolName;
	if (args?.action === "inspect") return "inspect definition";
	if (args?.action === "run_inspect") return "inspect run";
	if (args?.action === "rewind") return "rewind";
	if (args?.action === "list") return "list definitions";
	return "run";
}

export function HyperchartToolSummary({
	toolName,
	args,
	status,
	details,
	runs = [],
	onOpenRun,
}: HyperchartToolSummaryProps) {
	const inspected = useMemo(
		() =>
			hyperchartRunFromToolDetails(details, {
				status: status === "error" ? "failed" : status === "running" ? "running" : "completed",
			}),
		[details, status],
	);
	const persisted = useMemo(() => persistedRun(args, runs), [args, runs]);
	const run = inspected ?? persisted;
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const running = runningHyperchartStates(run);
	const usage = formatHyperchartUsage(run?.totalUsage);
	const chartName = run?.chartName ?? chartNameFromArgs(args) ?? "hyperchart";
	const isDefinition = run?.mode === "static";
	const canOpen = run !== undefined;
	const meta = run
		? isDefinition
			? "definition"
			: usage ?? run.status
		: status === "running"
			? "waiting…"
			: "not found";
	const open = () => {
		if (!run) return;
		if (!isDefinition && onOpenRun) onOpenRun(run.runId);
		else setInspectorOpen(true);
	};

	return (
		<div data-hyperchart-root className="w-full max-w-full">
			<button
				type="button"
				disabled={!canOpen}
				onClick={open}
				className={`group flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left text-xs transition ${canOpen ? "hover:bg-blue-500/5" : "cursor-default opacity-80"}`}
				data-testid={toolName === "hyperchart" && args?.action === "inspect" ? "inspected-hyperchart-graph-snippet" : undefined}
			>
				<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-[var(--hc-blue-text)]">
					{run?.status === "running" ? (
						<ArrowPathIcon className="h-4 w-4 animate-spin" />
					) : (
						<QueueListIcon className="h-4 w-4" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="truncate text-sm font-semibold text-[var(--text-primary)]" title={chartName}>
							{chartName}
						</span>
						<span className="shrink-0 text-[11px] text-[var(--text-muted)]">{actionLabel(toolName, args)}</span>
					</span>
					<span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">{meta}</span>
					{running.length > 0 && (
						<span className="mt-0.5 block truncate text-[11px] text-[var(--hc-blue-text)]">
							{running
								.slice(0, 2)
								.map((state) => state.id)
								.join(", ")}
						</span>
					)}
				</span>
				{canOpen && (
					<ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--hc-blue-text)]" />
				)}
			</button>
			{inspectorOpen && run && (
				<Suspense fallback={null}>
					<HyperchartInspectorDialog runs={[run]} selectedRunId={run.runId} onClose={() => setInspectorOpen(false)} />
				</Suspense>
			)}
		</div>
	);
}
