import React, { useEffect, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { FullPreDialog } from "./FullPreDialog.js";
import { HighlightedBlock } from "./HighlightedBlock.js";

export function ExpandablePre({
	children,
	collapsedMaxHeight = "max-h-48",
	expandedMaxHeight = "max-h-[70vh]",
	collapsedLines,
	showToggle = true,
	showOpenFull = true,
	language,
}: {
	children: React.ReactNode;
	collapsedMaxHeight?: string;
	expandedMaxHeight?: string;
	collapsedLines?: number | undefined;
	showToggle?: boolean;
	showOpenFull?: boolean;
	language?: string | undefined;
}) {
	const [expanded, setExpanded] = useState(false);
	const [fullOpen, setFullOpen] = useState(false);
	const [canExpand, setCanExpand] = useState(false);
	const blockRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const expandedRef = useRef(expanded);
	const collapsedOverflowClass = showToggle ? "overflow-y-hidden" : "overflow-y-auto";
	const collapsedClass =
		collapsedLines === undefined ? `${collapsedMaxHeight} ${collapsedOverflowClass}` : "overflow-y-hidden";
	const visibleClass = expanded ? `${expandedMaxHeight} overflow-y-auto` : collapsedClass;

	useEffect(() => {
		expandedRef.current = expanded;
	}, [expanded]);

	useEffect(() => {
		void children;
		void collapsedLines;
		void collapsedMaxHeight;
		void language;
		if (!showToggle) {
			setCanExpand(false);
			setExpanded(false);
			return;
		}
		const block = blockRef.current;
		if (!block) return;
		let frame = 0;
		const measure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (expandedRef.current) return;
				const fullHeight = measureRef.current?.scrollHeight ?? block.scrollHeight;
				const nextCanExpand = fullHeight > block.clientHeight + 1;
				setCanExpand(nextCanExpand);
				if (!nextCanExpand) setExpanded(false);
			});
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		observer?.observe(block);
		if (block.firstElementChild) observer?.observe(block.firstElementChild);
		if (measureRef.current) observer?.observe(measureRef.current);
		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [children, collapsedLines, collapsedMaxHeight, language, showToggle]);

	return (
		<div className="relative min-w-0 max-w-full space-y-1">
			<div
				ref={blockRef}
				className={`${visibleClass} min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)]`}
			>
				<HighlightedBlock language={language} clampLines={!expanded ? collapsedLines : undefined}>
					{children}
				</HighlightedBlock>
			</div>
			{showToggle && collapsedLines !== undefined && !expanded && (
				<div
					ref={measureRef}
					aria-hidden="true"
					className="pointer-events-none invisible absolute inset-x-0 top-0 -z-10 min-w-0 max-w-full overflow-visible rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)]"
				>
					<HighlightedBlock language={language}>{children}</HighlightedBlock>
				</div>
			)}
			{((showToggle && canExpand) || showOpenFull) && (
				<div className="flex items-center gap-3">
					{showToggle && canExpand && (
						<button
							type="button"
							onClick={() => setExpanded((value) => !value)}
							className="text-[10px] font-medium text-[var(--hc-blue-text)] hover:underline"
						>
							{expanded ? "Less" : "More"}
						</button>
					)}
					{showOpenFull && (
						<button
							type="button"
							onClick={() => setFullOpen(true)}
							className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--hc-blue-text)] hover:underline"
						>
							<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" /> Open full
						</button>
					)}
				</div>
			)}
			{fullOpen && (
				<FullPreDialog language={language} onClose={() => setFullOpen(false)}>
					{children}
				</FullPreDialog>
			)}
		</div>
	);
}
