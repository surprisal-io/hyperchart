import { CodeBracketSquareIcon } from "@heroicons/react/24/outline";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { Section } from "../ui/Section.js";

export function DefinitionSection({ source }: { source: string }) {
	return (
		<Section title="Definition" icon={CodeBracketSquareIcon} defaultOpen={false}>
			<ExpandablePre
				collapsedMaxHeight="max-h-[680px]"
				expandedMaxHeight="max-h-[680px]"
				showToggle={false}
				language="typescript"
			>
				{source}
			</ExpandablePre>
		</Section>
	);
}
