import { useState } from "react";
import { HyperchartInspectorSidePanel } from "../../HyperchartInspectorDialog.js";
import { CodeBlock } from "./CodeBlock.js";
import { GeneratedRuntimeBlock } from "./GeneratedRuntimeBlock.js";
import type { InspectorPanelTileProps } from "./types.js";

export function InspectorPanelTile(props: InspectorPanelTileProps) {
	const [navigatedStateId, setNavigatedStateId] = useState<string | null>();
	if (props.variant === "validation-error") {
		return (
			<article className="min-w-0 overflow-hidden rounded-2xl border border-red-500 bg-[var(--bg-secondary)] shadow-[0_16px_48px_var(--shadow-card)]">
				<div className="border-b border-red-500 px-3 py-2">
					<h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">{props.title}</h3>
					<p className="mt-1 text-[11px] leading-relaxed text-red-400">
						Hyperchart validation failed; the panel was not converted to a view model.
					</p>
				</div>
				<CodeBlock code={props.message} language="text" />
			</article>
		);
	}

	const { title, description, run, selectedStateId: initialSelectedStateId, definitionSource, runtimeSources } = props;
	const selectedStateId = navigatedStateId ?? initialSelectedStateId;
	const state = selectedStateId ? run.states.find((candidate) => candidate.id === selectedStateId) : undefined;
	return (
		<article className="min-w-0 overflow-x-auto overflow-y-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-[0_16px_48px_var(--shadow-card)]">
			<div className="border-b border-[var(--border-primary)] px-3 py-2">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
					<span className="shrink-0 rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
						{state ? `${state.type ?? "agent"} · ${state.status}` : "overview"}
					</span>
				</div>
				<div
					className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]"
					title={selectedStateId ?? run.runId}
				>
					{selectedStateId ?? "no node selected"}
				</div>
				<p className="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">{description}</p>
			</div>
			<div className="grid min-w-[980px] grid-cols-[430px_minmax(0,1fr)] gap-3 p-3">
				<div className="min-w-0 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]">
					<HyperchartInspectorSidePanel
						run={run}
						selectedStateId={selectedStateId}
						onOpenScope={() => undefined}
						onNavigateToState={setNavigatedStateId}
						definitionSource={definitionSource}
						className="bg-[var(--bg-secondary)]"
					/>
				</div>
				<div className="min-w-0 space-y-3">
					{runtimeSources.map((source) => (
						<GeneratedRuntimeBlock key={source.title} {...source} />
					))}
				</div>
			</div>
		</article>
	);
}
