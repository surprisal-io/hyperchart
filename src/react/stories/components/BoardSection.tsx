import React from "react";

export function BoardSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-[0_16px_60px_var(--shadow-card)]">
			<div className="border-b border-[var(--border-primary)] px-4 py-3">
				<h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
				{description && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{description}</p>}
			</div>
			<div className="p-4">{children}</div>
		</section>
	);
}
