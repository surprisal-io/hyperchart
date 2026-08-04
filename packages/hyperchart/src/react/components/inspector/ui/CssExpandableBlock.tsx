import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { FullPreDialog } from "./FullPreDialog.js";

export function CssExpandableBlock({
	render,
	previewText,
	fullText,
	contentTruncated = false,
}: {
	render: (text: string, full: boolean, closeFull?: () => void) => ReactNode;
	previewText: string;
	fullText: string;
	contentTruncated?: boolean;
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const [fullOpen, setFullOpen] = useState(false);
	const [contentOverflows, setContentOverflows] = useState(false);

	useLayoutEffect(() => {
		const content = contentRef.current;
		if (content === null) return;
		const measure = () => setContentOverflows(content.scrollHeight > content.clientHeight + 1);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	const expandable = contentTruncated || contentOverflows;
	return (
		<div className="min-w-0 max-w-full">
			<div
				ref={contentRef}
				className={`relative min-w-0 max-w-full overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)] max-h-[calc(2.9em+1rem)] ${expandable ? "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-6 after:bg-gradient-to-t after:from-[var(--bg-code)] after:to-transparent" : ""}`}
			>
				{render(previewText, false)}
			</div>
			{expandable && (
				<button type="button" onClick={() => setFullOpen(true)} className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-[var(--hc-blue-text)] hover:underline">
					<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" /> Open full
				</button>
			)}
			{fullOpen && <FullPreDialog onClose={() => setFullOpen(false)} wrapLongLines renderContent={(text) => render(text, true, () => setFullOpen(false))}>{fullText}</FullPreDialog>}
		</div>
	);
}
