import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type RunStorage = Readonly<{
	rootDir: string;
	layout: "run-id" | "sha256";
}> &
	(Readonly<{ kind: "jsonl" }> | Readonly<{ kind: "postgres"; dsn: string }>);

const scope = new AsyncLocalStorage<RunStorage>();

export function assertRunId(runId: string, layout = scope.getStore()?.layout ?? "run-id"): void {
	if (typeof runId !== "string" || runId.trim().length === 0 || runId.includes("\0"))
		throw new Error("Invalid Hyperchart runId");
	if (layout === "run-id" && (runId === "." || runId === ".." || /[/\\]/.test(runId)))
		throw new Error("Invalid Hyperchart runId: literal layout requires a single segment, not a path");
}

export function withRunStorage<T>(storage: RunStorage, operation: () => T): T {
	return scope.run(Object.freeze({ ...storage, rootDir: resolve(storage.rootDir) }), operation);
}

export function currentRunStorage(): RunStorage | undefined {
	return scope.getStore();
}

/** Internal filesystem coordinates. Never accept these as public run selectors. */
export function resolveRunPaths(
	runId: string,
	storage = scope.getStore(),
): Readonly<{ runDir: string; storage: RunStorage }> {
	assertRunId(runId, storage?.layout);
	if (storage === undefined) throw new Error("Hyperchart run storage scope is required");
	const segment = storage.layout === "sha256" ? createHash("sha256").update(runId, "utf8").digest("hex") : runId;
	const root = resolve(storage.rootDir);
	const runDir = join(root, segment);
	// A storage key must not escape through a pre-existing run-directory symlink.
	if (existsSync(runDir) && realpathSync(runDir) !== join(realpathSync(root), segment))
		throw new Error(`Hyperchart run '${runId}' escapes the configured storage root`);
	return { runDir, storage };
}
