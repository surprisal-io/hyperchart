import type { HyperchartVisitInvocationInfo } from "../../../types.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { JsonBlock } from "../ui/JsonBlock.js";

export function VisitInvocationDetails({ invocation }: { invocation: HyperchartVisitInvocationInfo }) {
	if (invocation.kind === "user") {
		return (
			<div>
				<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved prompt</div>
				<ExpandablePre collapsedLines={9}>{invocation.prompt}</ExpandablePre>
			</div>
		);
	}
	if (invocation.kind === "script") {
		return (
			<div className="space-y-2">
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved command</div>
					<ExpandablePre collapsedLines={5} language="bash">
						{[invocation.command, ...invocation.args].join(" ")}
					</ExpandablePre>
				</div>
				{invocation.args.length > 0 && (
					<div>
						<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">arguments</div>
						<JsonBlock value={invocation.args} previewLines={7} />
					</div>
				)}
				{invocation.env !== undefined && Object.keys(invocation.env).length > 0 && (
					<div>
						<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved env</div>
						<JsonBlock value={invocation.env} previewLines={9} />
					</div>
				)}
				{invocation.artifacts !== undefined && invocation.artifacts.length > 0 && (
					<div>
						<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">artifacts</div>
						<JsonBlock value={invocation.artifacts} previewLines={7} />
					</div>
				)}
			</div>
		);
	}
	return (
		<div className="space-y-2">
			{invocation.task !== undefined && (
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved task</div>
					<ExpandablePre collapsedLines={9}>{invocation.task}</ExpandablePre>
				</div>
			)}
			{invocation.resumeMessage !== undefined && (
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resume message</div>
					<ExpandablePre collapsedLines={6}>{invocation.resumeMessage}</ExpandablePre>
				</div>
			)}
			{invocation.reads !== undefined && invocation.reads.length > 0 && (
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved reads</div>
					<JsonBlock value={invocation.reads} previewLines={7} />
				</div>
			)}
			{invocation.artifacts !== undefined && invocation.artifacts.length > 0 && (
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">artifacts</div>
					<JsonBlock value={invocation.artifacts} previewLines={7} />
				</div>
			)}
		</div>
	);
}
