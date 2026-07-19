import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import { HyperchartInspectorDialog } from "../../react/HyperchartInspectorDialog.js";
import "../../react/styles.css";

type ThemeName = "light" | "dark";
type RunResponse = { run?: HyperchartRunInfo; error?: string };

function runToken(): string | undefined {
	const match = /^\/runs\/([A-Za-z0-9_-]+)$/.exec(window.location.pathname);
	return match?.[1];
}

function initialTheme(): ThemeName {
	const stored = window.localStorage.getItem("hyperchart-inspector-theme");
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function InspectorApp() {
	const [run, setRun] = useState<HyperchartRunInfo>();
	const [error, setError] = useState<string>();
	const [theme, setTheme] = useState<ThemeName>(initialTheme);
	const token = runToken();

	useEffect(() => {
		if (token === undefined) {
			setError("Invalid inspector URL");
			return;
		}
		let disposed = false;
		const load = async () => {
			try {
				const response = await fetch(`/api/runs/${token}`, { cache: "no-store" });
				const payload = (await response.json()) as RunResponse;
				if (!response.ok || payload.run === undefined) throw new Error(payload.error ?? `Inspector request failed (${response.status})`);
				if (!disposed) {
					setRun(payload.run);
					setError(undefined);
				}
			} catch (nextError) {
				if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError));
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 1_000);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, [token]);

	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		window.localStorage.setItem("hyperchart-inspector-theme", next);
		setTheme(next);
	};

	return (
		<div data-hyperchart-root data-theme={theme} className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
			<button
				type="button"
				onClick={toggleTheme}
				className="fixed right-20 top-6 z-[90] rounded-lg border border-[var(--border-primary)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-lg hover:bg-[var(--bg-secondary)]"
			>
				{theme === "dark" ? "Light theme" : "Dark theme"}
			</button>
			{run !== undefined ? (
				<HyperchartInspectorDialog
					runs={[run]}
					selectedRunId={run.runId}
					onClose={() => window.close()}
					theme={{ resolved: theme, themeName: theme }}
				/>
			) : (
				<div className="flex min-h-screen items-center justify-center p-8">
					<div className="max-w-xl rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-xl">
						<div className="text-sm font-semibold">Hyperchart inspector</div>
						<div className={`mt-2 text-sm ${error === undefined ? "text-[var(--text-muted)]" : "text-[var(--danger)]"}`}>
							{error ?? "Loading run…"}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("Hyperchart inspector root is missing");
createRoot(root).render(
	<StrictMode>
		<InspectorApp />
	</StrictMode>,
);
