import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeSegment } from "../../core/action_uid.js";
import { openRunLogStore } from "./log_store_factory.js";

export type RunMeta = {
	chartPath: string;
	exportName?: string;
	workDir: string;
	chartId: string;
	createdAt: string;
	originSessionId?: string;
};

export async function createRunDir(workDir: string, chartId: string, options: { rootDir?: string } = {}): Promise<string> {
	const root = options.rootDir ?? join(workDir, ".hyperchart", "runs");
	mkdirSync(root, { recursive: true });
	const stamp = formatTimestamp(new Date());
	const base = `${sanitizeSegment(chartId)}-${stamp}`;
	let candidate = join(root, base);
	let suffix = 1;
	while (existsSync(candidate)) {
		candidate = join(root, `${base}-${suffix++}`);
	}
	await initializeRunDir(candidate);
	return candidate;
}

export async function initializeRunDir(runDir: string): Promise<void> {
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	const store = await openRunLogStore(runDir, { access: "writer" });
	try {
		await store.initializeRootBranch();
	} finally {
		await store.close();
	}
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
