import { ArrowPathIcon, CheckBadgeIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { validationRetryLabel } from "../helpers/state.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { Section } from "../ui/Section.js";

export function ValidationSection({ state }: { state: HyperchartStateInfo }) {
	const validationLabel = validationRetryLabel(state);
	const rejectionReason =
		state.validation?.latestRejectedReason ??
		state.issues?.find((issue) => issue.kind === "validation_rejected")?.message;
	if (
		state.guard === undefined &&
		state.onReject === undefined &&
		state.retry === undefined &&
		validationLabel === undefined &&
		rejectionReason === undefined
	)
		return null;
	const retryText =
		state.retry?.max === undefined ? "unbounded" : `${state.retry.max} retr${state.retry.max === 1 ? "y" : "ies"}`;
	return (
		<Section title="Validation guard" icon={CheckBadgeIcon}>
			{state.guard === undefined ? (
				<div className="text-[var(--text-muted)]">No guard definition available.</div>
			) : state.guard.kind === "script" ? (
				<div className="space-y-1">
					<div className="inline-flex rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--hc-green-text)]">
						script guard
					</div>
					<ExpandablePre collapsedMaxHeight="max-h-24" language="bash">
						{[state.guard.command, ...(state.guard.args ?? [])].join(" ")}
					</ExpandablePre>
				</div>
			) : (
				<div className="space-y-1">
					<div className="inline-flex rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--hc-green-text)]">
						imported guard
					</div>
					<dl className="grid grid-cols-2 gap-2 text-[11px]">
						<div>
							<dt className="text-[var(--text-muted)]">module</dt>
							<dd>
								<code className="block overflow-x-auto whitespace-pre rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-[10px]">
									{state.guard.module}
								</code>
							</dd>
						</div>
						<div>
							<dt className="text-[var(--text-muted)]">export</dt>
							<dd>
								<code className="block overflow-x-auto whitespace-pre rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-[10px]">
									{state.guard.export}
								</code>
							</dd>
						</div>
					</dl>
				</div>
			)}
			{validationLabel && (
				<div className="inline-flex max-w-full items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-[var(--hc-amber-text)]">
					<ArrowPathIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{validationLabel}</span>
				</div>
			)}
			{rejectionReason && (
				<div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-[11px] text-[var(--text-secondary)]">
					<div className="mb-1 font-semibold text-[var(--hc-amber-text)]">latest rejection</div>
					<div className="whitespace-pre-wrap break-words">{rejectionReason}</div>
				</div>
			)}
			<dl className="grid grid-cols-2 gap-2 text-[11px]">
				{state.guard !== undefined && (
					<div>
						<dt className="text-[var(--text-muted)]">on reject</dt>
						<dd>{state.onReject ?? "resume"}</dd>
					</div>
				)}
				<div>
					<dt className="text-[var(--text-muted)]">retry budget</dt>
					<dd>{retryText}</dd>
				</div>
			</dl>
		</Section>
	);
}
