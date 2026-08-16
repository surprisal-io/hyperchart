import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeSegment } from "../../core/action_uid.js";
import { JsonlLogStore } from "./log_store.js";

export type RunMeta = {
	chartPath: string;
	exportName?: string;
	workDir: string;
	chartId: string;
	createdAt: string;
	originSessionId?: string;
};

export function createRunDir(workDir: string, chartId: string, options: { rootDir?: string } = {}): string {
	const root = options.rootDir ?? join(workDir, ".hyperchart", "runs");
	mkdirSync(root, { recursive: true });
	const stamp = formatTimestamp(new Date());
	const base = `${sanitizeSegment(chartId)}-${stamp}`;
	let candidate = join(root, base);
	let suffix = 1;
	while (existsSync(candidate)) {
		candidate = join(root, `${base}-${suffix++}`);
	}
	initializeRunDir(candidate);
	return candidate;
}

export function initializeRunDir(runDir: string): void {
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	new JsonlLogStore(join(runDir, "log.jsonl")).initializeRootBranch();
}

export function loadRunMeta(runDir: string): RunMeta {
	const parsed = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
	return {
		...parsed,
		chartPath: resolve(parsed.chartPath),
		workDir: resolve(parsed.workDir),
	};
}

export function saveRunMeta(runDir: string, meta: RunMeta): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	mkdirSync(join(runDir, "sessions"), { recursive: true });
}

function formatTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
		date.getMinutes(),
	)}${pad(date.getSeconds())}`;
}
