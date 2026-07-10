import type { HyperchartStateInfo } from "../../types.js";
import { MapResolvedInputList } from "../../components/inspector/details/MapResolvedInputList.js";
import { TemplateTextBlock } from "../../components/inspector/prompt/TemplateTextBlock.js";
import { ExpandablePre } from "../../components/inspector/ui/ExpandablePre.js";
import { JsonBlock } from "../../components/inspector/ui/JsonBlock.js";
import { BoardPage } from "./BoardPage.js";
import { BoardSection } from "./BoardSection.js";
import { PreviewStateCard } from "./PreviewStateCard.js";

const promptState: HyperchartStateInfo = {
	id: "preview-prompt",
	type: "agent",
	status: "pending",
};

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
	'  transitions: { DONE: "done", FAILED: "failed" },',
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

const fittingMapState: HyperchartStateInfo = {
	id: "map-fitting-preview",
	type: "map",
	status: "running",
	mapConfig: {
		items: [
			{
				key: "summary",
				label: "Executive summary",
				status: "done",
				summary: "One verified section.",
				value: { title: "Summary", approved: true },
			},
		],
	},
};

const clippedMapState: HyperchartStateInfo = {
	id: "map-clipped-preview",
	type: "map",
	status: "running",
	mapConfig: {
		items: [
			{
				key: "platform-review-with-a-long-key",
				label: "Platform review with detailed resolved source material",
				status: "running",
				summary: Array.from(
					{ length: 9 },
					(_, index) => `Evidence note ${index + 1}: verified source and review context.`,
				).join("\n"),
				value: {
					title: "Platform review",
					sections: Array.from({ length: 16 }, (_, index) => ({
						id: `section-${index + 1}`,
						status: index < 4 ? "done" : "pending",
						note: `Resolved map value for section ${index + 1}.`,
					})),
				},
			},
		],
	},
};

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
