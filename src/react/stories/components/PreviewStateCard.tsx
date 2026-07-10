import React from "react";

export function PreviewStateCard({
	label,
	expectation,
	children,
}: {
	label: string;
	expectation: "fits" | "clipped";
	children: React.ReactNode;
}) {
	return (
		<article className="min-w-0 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
			<div className="mb-3 flex items-center justify-between gap-3">
				<h3 className="text-xs font-semibold text-[var(--text-primary)]">{label}</h3>
				<span
					className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
						expectation === "clipped"
							? "border-amber-500/35 bg-amber-500/10 text-[var(--hc-amber-text)]"
							: "border-emerald-500/35 bg-emerald-500/10 text-[var(--hc-green-text)]"
					}`}
				>
					{expectation === "clipped" ? "Open full expected" : "No control expected"}
				</span>
			</div>
			{children}
		</article>
	);
}
