import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HyperchartRunInfo } from "../host/index.js";
import { browserHistoryDataSource } from "./inspector_http_client.js";
import type { HistorySnapshot } from "../runtime/generic/log_store.js";
import { HyperchartInspectorDialog } from "../react/HyperchartInspectorDialog.js";
import "../react/styles.css";

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
	const [latestHistorySnapshot, setLatestHistorySnapshot] = useState<HistorySnapshot>();
	const [selectedBranchId, setSelectedBranchId] = useState<string>();
	const [theme, setTheme] = useState<ThemeName>(initialTheme);
	const token = runToken();
	const historyDataSource = useMemo(() => token === undefined ? undefined : browserHistoryDataSource(token), [token]);
	const linkedSeqId = Number(new URLSearchParams(window.location.search).get("seqId"));
	const historyTargetSeqId = Number.isSafeInteger(linkedSeqId) && linkedSeqId > 0 ? linkedSeqId : undefined;

	useEffect(() => {
		if (token === undefined) {
			setError("Invalid inspector URL");
			return;
		}
		let disposed = false;
		let loading = false;
		const load = async () => {
			if (loading) return;
			loading = true;
			try {
				const branchQuery = selectedBranchId === undefined ? "" : `?branchId=${encodeURIComponent(selectedBranchId)}`;
				const response = await fetch(`/api/runs/${token}${branchQuery}`, { cache: "no-store" });
				const payload = (await response.json()) as RunResponse;
				if (!response.ok || payload.run === undefined) throw new Error(payload.error ?? `Inspector request failed (${response.status})`);
				if (!disposed) {
					setLatestHistorySnapshot(payload.run.historySnapshot);
					setRun((current) => {
						const preserve = current?.runId === payload.run!.runId && current.branchId === payload.run!.branchId
							? current.historySnapshot
							: undefined;
						return { ...payload.run!, ...(preserve === undefined ? {} : { historySnapshot: preserve }) };
					});
					setError(undefined);
				}
			} catch (nextError) {
				if (!disposed) setError(nextError instanceof Error ? nextError.message : String(nextError));
			} finally {
				loading = false;
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 400);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, [selectedBranchId, token]);

	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		window.localStorage.setItem("hyperchart-inspector-theme", next);
		setTheme(next);
	};

	const steerSession = async (_runId: string, actionKey: string, message: string) => {
		if (token === undefined) throw new Error("Invalid inspector URL");
		if (run?.branchId === undefined) throw new Error("The selected branch is unavailable");
		const response = await fetch(`/api/runs/${token}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ branchId: run.branchId, actionKey, message }),
		});
		const payload = (await response.json()) as { error?: string };
		if (!response.ok) throw new Error(payload.error ?? `Steering request failed (${response.status})`);
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
					onSelectBranch={(_runId, branchId) => setSelectedBranchId(branchId)}
					onSteerSession={steerSession}
					onRefreshHistory={() => setRun((current) => current === undefined || latestHistorySnapshot === undefined ? current : { ...current, historySnapshot: latestHistorySnapshot })}
					{...(historyDataSource === undefined ? {} : { historyDataSource })}
					{...(historyTargetSeqId === undefined ? {} : { historyTargetSeqId })}
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
