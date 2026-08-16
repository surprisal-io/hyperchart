import type { HyperchartStateInfo, HyperchartVisitInvocationInfo } from "../../../types.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { schemaTypeText } from "../helpers/schema.js";
import { TemplateTextBlock } from "../prompt/TemplateTextBlock.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { ArtifactRow } from "./ArtifactRow.js";

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
							const typeName = (read.name ?? `read-${index + 1}`).split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Read";
							return (
								<ArtifactRow
									key={`${read.path}:${index}`}
									{...(artifactBacked ? { kind: joined ? "join" as const : "single" as const } : {})}
									label={artifactBacked ? `${read.sourceState} → ${read.name}` : read.path}
									{...(artifactBacked ? { detail: `${read.path}${read.select === undefined ? "" : ` · select ${read.select}`}` } : {})}
									{...(read.schema === undefined ? {} : { typeText: `type ${typeName} = ${schemaTypeText(read.schema)};` })}
									{...(artifactBacked && onHighlightArtifact !== undefined ? { onClick: () => onHighlightArtifact(read.sourceState!, read.name!) } : {})}
								/>
							);
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
