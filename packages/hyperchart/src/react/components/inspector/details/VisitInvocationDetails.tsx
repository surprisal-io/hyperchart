import { ArchiveBoxIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartVisitInvocationInfo } from "../../../types.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { schemaTypeText } from "../helpers/schema.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

export function VisitInvocationDetails({ invocation, state, allStates, onHighlightArtifact }: { invocation: HyperchartVisitInvocationInfo; state: HyperchartStateInfo; allStates: HyperchartStateInfo[]; onHighlightArtifact?: (stateId: string, artifactName: string) => void }) {
	if (invocation.kind === "actor") return null;
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
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved prompt</div>
					<TemplateTextBlock text={invocation.task} state={state} allStates={allStates} cssCollapse />
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
					<div className="grid gap-1.5">
						{invocation.reads.map((read, index) => {
							const artifactBacked = read.sourceState !== undefined && read.name !== undefined;
							const joined = read.readKind === "join";
							const ReadIcon = joined ? RectangleStackIcon : ArchiveBoxIcon;
							const label = artifactBacked ? `${read.sourceState} → ${read.name}` : read.path;
							const typeName = (read.name ?? `read-${index + 1}`).split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Read";
							const type = read.schema === undefined ? undefined : `type ${typeName} = ${schemaTypeText(read.schema)};`;
							const labelNode = <span>{label}</span>;
							const content = (
								<>
									<span className={`flex w-max items-center gap-1 whitespace-nowrap font-mono text-[10px] ${artifactBacked ? "text-[var(--hc-purple-text)]" : "text-[var(--text-secondary)]"}`}>
										{artifactBacked && <TypeTooltip text={joined ? "joined artifact" : "artifact"}><span data-hyperchart-tooltip-isolated data-artifact-read-kind={joined ? "join" : "single"} className="inline-flex"><ReadIcon className="h-3 w-3 shrink-0" aria-hidden="true" /></span></TypeTooltip>}
										{labelNode}
									</span>
									{artifactBacked && <span className="w-max whitespace-nowrap font-mono text-[9px] text-[var(--text-muted)]">{read.path}{read.select === undefined ? "" : ` · select ${read.select}`}</span>}
								</>
							);
							const trigger = artifactBacked && onHighlightArtifact !== undefined ? (
								<button type="button" onClick={() => onHighlightArtifact(read.sourceState!, read.name!)} className="flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border border-purple-500/20 bg-purple-500/5 px-2 py-1.5 text-left hover:bg-purple-500/10">{content}</button>
							) : (
								<div className="flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] px-2 py-1.5">{content}</div>
							);
							return type === undefined
								? <div key={`${read.path}:${index}`}>{trigger}</div>
								: <TypeTooltip key={`${read.path}:${index}`} text={type}>{trigger}</TypeTooltip>;
						})}
					</div>
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
