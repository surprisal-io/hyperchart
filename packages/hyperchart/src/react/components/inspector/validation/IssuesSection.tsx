import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { HyperchartIssueInfo } from "../../../types.js";
import { Section } from "../ui/Section.js";
import { IssueCard } from "./IssueCard.js";

export function IssuesSection({
	issues,
	title = "Issues",
}: {
	issues: readonly HyperchartIssueInfo[] | undefined;
	title?: string;
}) {
	if (!issues || issues.length === 0) return null;
	return (
		<Section title={title} icon={ExclamationTriangleIcon}>
			<div className="space-y-2">
				{issues.map((issue, index) => (
					<IssueCard key={`${issue.kind}-${issue.seqId ?? index}-${issue.message}`} issue={issue} />
				))}
			</div>
		</Section>
	);
}
