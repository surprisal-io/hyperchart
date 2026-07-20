import { useState, type ReactNode } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { createTextPreview } from "../helpers/textPreview.js";
import { FullPreDialog } from "./FullPreDialog.js";
import { HighlightedBlock } from "./HighlightedBlock.js";

export function ExpandablePre({
	children,
	collapsedLines = 12,
	maxPreviewCharacters = 2_000,
	language,
	renderContent,
	wrapLongLines = false,
}: {
	children: string;
	collapsedLines?: number;
	maxPreviewCharacters?: number;
	language?: string | undefined;
	renderContent?: (text: string) => ReactNode;
	wrapLongLines?: boolean;
}) {
	const [fullOpen, setFullOpen] = useState(false);
	const preview = createTextPreview(children, collapsedLines, maxPreviewCharacters);

	return (
		<div className="relative min-w-0 max-w-full space-y-1">
			<div className="min-w-0 max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)]">
				{renderContent ? (
					renderContent(preview.text)
				) : (
					<HighlightedBlock language={language} wrapLongLines={wrapLongLines}>{preview.text}</HighlightedBlock>
				)}
			</div>
			{preview.truncated && (
				<button
					type="button"
					onClick={() => setFullOpen(true)}
					className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--hc-blue-text)] hover:underline"
				>
					<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" /> Open full
				</button>
			)}
			{fullOpen && (
				<FullPreDialog language={language} onClose={() => setFullOpen(false)}>
					{children}
				</FullPreDialog>
			)}
		</div>
	);
}
