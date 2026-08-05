import { BoardPage } from "./BoardPage.js";
import { BoardSection } from "./BoardSection.js";
import { InspectorPanelTile } from "./InspectorPanelTile.js";
import type { InspectorPanelTileProps } from "./types.js";

type InspectorPanelGroup = {
	id: string;
	title: string;
	description: string;
};

type InspectorPanelGroupedSpec = {
	group: string;
	runtime: { selectedStateId: string | null };
};

export function InspectorPanelGroupBoard<TSpec extends InspectorPanelGroupedSpec>({
	groupId,
	groups,
	specs,
	buildTileProps,
}: {
	groupId: string;
	groups: readonly InspectorPanelGroup[];
	specs: readonly TSpec[];
	buildTileProps: (spec: TSpec) => InspectorPanelTileProps;
}) {
	const group = groups.find((item) => item.id === groupId);
	const groupSpecs = specs.filter((spec) => spec.group === groupId);
	if (group === undefined) return null;
	return (
		<BoardPage
			title={`Inspector panel · ${group.title}`}
			description={`${group.description} Это отдельная review board только для этого типа state/node.`}
		>
			<BoardSection
				title={group.title}
				description={`${groupSpecs.length} panel ${groupSpecs.length === 1 ? "case" : "cases"}.`}
			>
				<div className="space-y-5">
					{groupSpecs.map((spec, index) => (
						<InspectorPanelTile
							key={`${group.id}:${spec.runtime.selectedStateId ?? "overview"}:${index}`}
							{...buildTileProps(spec)}
						/>
					))}
				</div>
			</BoardSection>
		</BoardPage>
	);
}
