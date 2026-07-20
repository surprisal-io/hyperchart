import React from "react";

export function BoardPage({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-h-screen bg-[var(--bg-primary)] p-5 text-[var(--text-primary)]">
			<div className="mx-auto max-w-[1800px] space-y-5">
				<header className="space-y-1">
					<div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--hc-blue-text)]">
						Hyperchart visual QA board
					</div>
					<h1 className="text-xl font-semibold">{title}</h1>
					{description && <p className="max-w-4xl text-sm text-[var(--text-secondary)]">{description}</p>}
				</header>
				{children}
			</div>
		</div>
	);
}
