import React, { useId, useRef } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { DialogPortal } from "../../../support/DialogPortal.js";
import { useModalDialog } from "../../../support/useModalDialog.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";
import { HighlightedBlock } from "./HighlightedBlock.js";

export function FullPreDialog({
	children,
	language,
	onClose,
}: {
	children: React.ReactNode;
	language?: string | undefined;
	onClose: () => void;
}) {
	const { resolved } = useHyperchartTheme();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose });
	return (
		<DialogPortal>
			<div
				data-hyperchart-root
				data-theme={resolved}
				className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
			>
				<button
					type="button"
					tabIndex={-1}
					className="absolute inset-0 cursor-default bg-[var(--bg-overlay)]"
					onClick={onClose}
					aria-label="Close full content"
				/>
				<div
					ref={dialogRef}
					tabIndex={-1}
					className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-primary)] shadow-2xl"
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
				>
					<div className="flex items-center justify-between gap-3 border-b border-[var(--border-primary)] px-4 py-3">
						<div id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
							Full content
						</div>
						<button
							ref={closeButtonRef}
							type="button"
							onClick={onClose}
							className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
							aria-label="Close full content"
						>
							<XMarkIcon className="h-5 w-5" aria-hidden="true" />
						</button>
					</div>
					<div className="min-h-0 overflow-auto p-4">
						<div className="min-w-0 max-w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)]">
							<HighlightedBlock language={language} full>
								{children}
							</HighlightedBlock>
						</div>
					</div>
				</div>
			</div>
		</DialogPortal>
	);
}
