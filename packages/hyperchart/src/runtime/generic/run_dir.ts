import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeSegment } from "../../core/action_uid.js";
import type { RunMeta } from "./log_store.js";
import { openRunLogStore } from "./log_store_factory.js";

export type { RunMeta } from "./log_store.js";

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

export async function loadRunMeta(runDir: string): Promise<RunMeta> {
	const store = await openRunLogStore(runDir, { access: "read" });
	try {
		const meta = await store.readRunMeta();
		if (meta === undefined) throw missingRunMeta(runDir);
		return normalizeRunMeta(meta);
	} finally {
		await store.close();
	}
}

export async function saveRunMeta(runDir: string, meta: RunMeta): Promise<void> {
	const absoluteRunDir = resolve(runDir);
	mkdirSync(absoluteRunDir, { recursive: true });
	mkdirSync(join(absoluteRunDir, "sessions"), { recursive: true });
	const store = await openRunLogStore(absoluteRunDir, { access: "writer" });
	try {
		await store.writeRunMeta(normalizeRunMeta(meta));
	} finally {
		await store.close();
	}
}

export async function deleteRunStorage(runDir: string): Promise<void> {
	const store = await openRunLogStore(runDir, { access: "writer" });
	try {
		await store.deleteRunData();
	} finally {
		await store.close();
	}
}

function normalizeRunMeta(meta: RunMeta): RunMeta {
	return {
		...meta,
		chartPath: resolve(meta.chartPath),
		workDir: resolve(meta.workDir),
	};
}

function missingRunMeta(runDir: string): NodeJS.ErrnoException {
	const error = new Error(`No Hyperchart run metadata for ${resolve(runDir)}`) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	return error;
}

function formatTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
		date.getMinutes(),
	)}${pad(date.getSeconds())}`;
}
