import { BoltIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { formatHyperchartDateTime, formatHyperchartUsage } from "../../../hyperchart-display.js";
import { stateHasRuntimeDetails } from "../helpers/state.js";
import { FanoutStatusCard } from "../graph/FanoutStatusCard.js";
import { Section } from "../ui/Section.js";
import { MapResolvedInputList } from "./MapResolvedInputList.js";
import { VisitHistory } from "./VisitHistory.js";

export function RuntimeSection({ state }: { state: HyperchartStateInfo }) {
	if (!stateHasRuntimeDetails(state)) return null;
	return (
		<Section title="Runtime" icon={BoltIcon} defaultOpen={false}>
			{(state.startedAt !== undefined ||
				state.endedAt !== undefined ||
				state.mapItemLabel ||
				state.visits !== undefined) && (
				<dl className="grid grid-cols-2 gap-2 text-[11px]">
					{state.startedAt !== undefined && (
						<div>
							<dt className="text-[var(--text-muted)]">started</dt>
							<dd>{formatHyperchartDateTime(state.startedAt)}</dd>
						</div>
					)}
					{state.endedAt !== undefined && (
						<div>
							<dt className="text-[var(--text-muted)]">ended</dt>
							<dd>{formatHyperchartDateTime(state.endedAt)}</dd>
						</div>
					)}
					{state.mapItemLabel && (
						<div className="min-w-0">
							<dt className="text-[var(--text-muted)]">map item</dt>
							<dd className="truncate" title={state.mapItemLabel}>
								{state.mapItemLabel}
							</dd>
						</div>
					)}
					{state.visits !== undefined && (
						<div>
							<dt className="text-[var(--text-muted)]">visits</dt>
							<dd>{state.visits}</dd>
						</div>
					)}
				</dl>
			)}
			<FanoutStatusCard state={state} />
			{state.usage && (
				<div className="text-[11px] text-[var(--text-tertiary)]">
					usage: {formatHyperchartUsage(state.usage) ?? JSON.stringify(state.usage)}
				</div>
			)}
			{state.visitHistory !== undefined && <VisitHistory visits={state.visitHistory} />}
			{state.type === "map" && <MapResolvedInputList state={state} />}
		</Section>
	);
}
