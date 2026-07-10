import React, { useEffect } from "react";

export function ThemeFrame({ resolved, children }: { resolved: "light" | "dark"; children: React.ReactNode }) {
	useEffect(() => {
		document.documentElement.dataset.theme = resolved;
		document.body.dataset.theme = resolved;
		return () => {
			delete document.documentElement.dataset.theme;
			delete document.body.dataset.theme;
		};
	}, [resolved]);
	return (
		<div
			data-hyperchart-root
			data-theme={resolved}
			className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]"
		>
			{children}
		</div>
	);
}
