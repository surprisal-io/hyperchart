import { useId, useRef, useState } from "react";
import { DialogPortal } from "../../support/DialogPortal.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { useModalDialog } from "../../support/useModalDialog.js";
import type { HyperchartLaunchDialogProps } from "./dialog-props.js";

export function HyperchartLaunchDialogInner({
	chartName,
	description,
	args,
	submitLabel = "Run",
	placeholder,
	onSubmit,
	onCancel,
	onOpenGraph,
}: Omit<HyperchartLaunchDialogProps, "portal">) {
	const { resolved } = useHyperchartTheme();
	const titleId = useId();
	const textareaId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [value, setValue] = useState("");
	useModalDialog({ dialogRef, initialFocusRef: textareaRef, onClose: onCancel });
	const argsHint =
		args && Object.keys(args).length > 0
			? JSON.stringify(
					Object.fromEntries(
						Object.entries(args).map(([key, spec]) => [key, (spec as { default?: unknown })?.default ?? ""]),
					),
					null,
					2,
				)
			: "";
	return (
		<DialogPortal>
			<div
				data-hyperchart-root
				data-theme={resolved}
				className="fixed inset-0 bg-[var(--bg-overlay)] flex items-center justify-center z-50 p-4"
			>
				<div
					ref={dialogRef}
					tabIndex={-1}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className="w-full max-w-lg bg-[var(--bg-secondary)] border border-[var(--border-secondary)] rounded-xl shadow-xl overflow-hidden"
				>
					<div className="px-4 py-3 border-b border-[var(--border-primary)]">
						<div id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
							{chartName}
						</div>
						{description && <div className="text-xs text-[var(--text-secondary)] mt-1">{description}</div>}
					</div>
					<div className="p-4 space-y-3">
						<label htmlFor={textareaId} className="block text-xs text-[var(--text-muted)]">
							Arguments JSON or free-form instruction
						</label>
						<textarea
							id={textareaId}
							ref={textareaRef}
							value={value}
							onChange={(event) => setValue(event.currentTarget.value)}
							placeholder={placeholder ?? (argsHint ? argsHint : "optional args / instruction…")}
							rows={8}
							className="w-full px-3 py-2 text-sm font-mono bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] resize-y"
							onKeyDown={(event) => {
								if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onSubmit(value.trim());
							}}
						/>
						<div className="text-[11px] text-[var(--text-muted)]">
							Tip: saved Hypercharts parse JSON args. Cmd/Ctrl+Enter submits.
						</div>
					</div>
					<div className="px-4 py-3 border-t border-[var(--border-primary)] flex justify-end gap-2">
						{onOpenGraph && (
							<button
								type="button"
								onClick={onOpenGraph}
								className="mr-auto px-3 py-1.5 text-xs rounded border border-blue-500/35 text-[var(--hc-blue-text)] hover:bg-blue-500/10"
							>
								Graph
							</button>
						)}
						<button
							type="button"
							onClick={onCancel}
							className="px-3 py-1.5 text-xs rounded border border-[var(--border-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => onSubmit(value.trim())}
							className="px-3 py-1.5 text-xs rounded bg-[var(--accent-blue)] text-white hover:opacity-90"
						>
							{submitLabel}
						</button>
					</div>
				</div>
			</div>
		</DialogPortal>
	);
}
