import { actorBusyFifoRun, actorNamedReplyRun, actorOverflowRun } from "../../fixtures/actor-fixtures.js";
import { inspectorPanelSpecs } from "../inspector-panel/specs.js";
import { inspectorPanelScenario } from "../inspector-panel/runtime.js";
import { ActorMailboxCard } from "../../components/inspector/details/ActorMailboxCard.js";
import { ActorProtocolCard } from "../../components/inspector/details/ActorProtocolCard.js";
import { MapResolvedInputList } from "../../components/inspector/details/MapResolvedInputList.js";
import { TemplateTextBlock } from "../../components/inspector/prompt/TemplateTextBlock.js";
import { ExpandablePre } from "../../components/inspector/ui/ExpandablePre.js";
import { JsonBlock } from "../../components/inspector/ui/JsonBlock.js";
import { BoardPage } from "./BoardPage.js";
import { BoardSection } from "./BoardSection.js";
import { PreviewStateCard } from "./PreviewStateCard.js";

function requiredScenarioState(group: "agent" | "map", title: string) {
	const spec = inspectorPanelSpecs.find((candidate) => candidate.group === group && candidate.title === title);
	const scenario = spec === undefined ? undefined : inspectorPanelScenario(spec);
	const state = scenario?.selectedStateId === null ? undefined : scenario?.run.states.find((candidate) => candidate.id === scenario?.selectedStateId);
	if (state === undefined) throw new Error(`adapter-derived content preview state is unavailable: ${title}`);
	return state;
}
const promptState = requiredScenarioState("agent", "Rich agent");

const fittingJson = {
	ok: true,
	count: 2,
};

const clippedJson = {
	runId: "preview-overflow",
	items: Array.from({ length: 18 }, (_, index) => ({
		id: `item-${index + 1}`,
		status: index % 3 === 0 ? "running" : "done",
		description: `Resolved item ${index + 1} with enough detail to exercise the bounded JSON preview.`,
	})),
};

const fittingPrompt = "Summarize the verified findings and return the final recommendation.";
const clippedPrompt = Array.from(
	{ length: 18 },
	(_, index) => `${index + 1}. Explain verification step ${index + 1} and include the supporting evidence.`,
).join("\n");

const fittingCommand = "node scripts/render-report.mjs --format html";
const clippedCommand = [
	"node scripts/render-report.mjs \\",
	'  --topic "Quarterly platform review" \\',
	"  --include official-sources \\",
	"  --include market-context \\",
	"  --include developer-feedback \\",
	"  --validate links \\",
	"  --validate citations \\",
	"  --validate accessibility \\",
	"  --output artifacts/report.html \\",
	"  --metadata artifacts/report.json",
].join("\n");

const fittingDefinition = [
	'"render": script("node", ["scripts/render-report.mjs"], {',
	'  transitions: { DONE: "done", ERROR: "failed" },',
	"}),",
].join("\n");
const clippedDefinition = [
	'"publish-report": compound({',
	'  initial: "prepare",',
	"  states: {",
	...Array.from(
		{ length: 22 },
		(_, index) =>
			`    "verify-${index + 1}": state({ action: agent("reviewer", { task: "Verify section ${index + 1}" }) }),`,
	),
	"  },",
	"}),",
].join("\n");

const fittingMapState = requiredScenarioState("map", "Map parent");

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`adapter-derived actor preview fixture is missing ${name}`);
	return value;
}
const fittingActorContract = required(actorNamedReplyRun.actorDeclarations?.[0]?.protocol[0], "fitting protocol");
const clippedActorContract = required(actorOverflowRun.actorDeclarations?.[0]?.protocol[0], "overflow protocol");
const fittingActorMailbox = required(actorBusyFifoRun.actorOccurrences?.[0]?.mailboxInstances, "fitting mailbox");
const clippedActorMailbox = required(actorOverflowRun.actorOccurrences?.find((occurrence) => occurrence.mailbox.totalCount > 0)?.mailboxInstances, "overflow mailbox");

const clippedMapState = requiredScenarioState("map", "Map parent overflow");

export function ContentPreviewBoard() {
	return (
		<BoardPage
			title="Content preview overflow states"
			description="Для каждого preview-блока: fitting и truncated states. В initial DOM попадает только bounded excerpt; полный текст монтируется только после Open full."
		>
			<BoardSection
				title="JSON"
				description="JsonBlock with the same bounded-height behavior used by run arguments and runtime payloads."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<JsonBlock value={fittingJson} previewLines={6} />
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<JsonBlock value={clippedJson} previewLines={6} />
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection
				title="Text / prompt"
				description="Plain prompt preview used for resolved tasks, prompts, and messages."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<TemplateTextBlock text={fittingPrompt} state={promptState} allStates={[promptState]} collapsedLines={5} />
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<TemplateTextBlock text={clippedPrompt} state={promptState} allStates={[promptState]} collapsedLines={5} />
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection title="Command" description="Shell command preview used by script states and resolved invocations.">
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<ExpandablePre collapsedLines={5} language="bash">
							{fittingCommand}
						</ExpandablePre>
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<ExpandablePre collapsedLines={5} language="bash">
							{clippedCommand}
						</ExpandablePre>
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection
				title="Definition"
				description="Validated DSL source preview with modal-only access to vertically clipped content."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<ExpandablePre collapsedLines={8} language="typescript">
							{fittingDefinition}
						</ExpandablePre>
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<ExpandablePre collapsedLines={8} language="typescript">
							{clippedDefinition}
						</ExpandablePre>
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection
				title="Actor protocol"
				description="The real ActorProtocolCard with compact and schema-heavy message/reply contracts."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<ActorProtocolCard contract={fittingActorContract} />
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<ActorProtocolCard contract={clippedActorContract} />
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection
				title="Actor FIFO mailbox"
				description="The real ActorMailboxCard with one message and an expandable long FIFO queue."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<ActorMailboxCard instances={fittingActorMailbox} />
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<ActorMailboxCard instances={clippedActorMailbox} />
					</PreviewStateCard>
				</div>
			</BoardSection>

			<BoardSection
				title="Map values"
				description="Real MapResolvedInputList cards, including bounded summary and JSON value previews."
			>
				<div className="grid gap-4 xl:grid-cols-2">
					<PreviewStateCard label="Fits" expectation="fits">
						<MapResolvedInputList state={fittingMapState} />
					</PreviewStateCard>
					<PreviewStateCard label="Does not fit" expectation="clipped">
						<MapResolvedInputList state={clippedMapState} />
					</PreviewStateCard>
				</div>
			</BoardSection>
		</BoardPage>
	);
}
