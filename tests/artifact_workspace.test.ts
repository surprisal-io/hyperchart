import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactPin, DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { materializeWorkspace } from "../packages/hyperchart/src/runtime/generic/artifact_workspace.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";

const roots: string[] = [];
const uid = { chart: "workspace", state: "write", action: "agent" } as const;

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hyperchart-workspace-"));
	roots.push(path);
	return path;
}

function completion(seqId: number, branchId: string, artifacts: Record<string, ArtifactPin>): DurableLogRecord {
	return {
		type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, artifacts,
		seqId, parentId: seqId === 1 ? null : seqId - 1, branchId, timestamp: seqId,
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("materializeWorkspace", () => {
	it("materializes the latest inherited parent revision into a fork workspace", async () => {
		const dir = await root();
		const store = new ArtifactStore(join(dir, "run"));
		const source = join(dir, "parent-report.md");
		await writeFile(source, "parent accepted bytes");
		const pin = await store.put(source);
		const logStore = new JsonlLogStore(join(dir, "run", "log.jsonl"));
		logStore.initializeRootBranch();
		const [accepted] = logStore.appendDrafts([{
			type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" },
			artifacts: { "nested/report.md": pin },
		}]);
		logStore.createBranch("fork", accepted!.seqId, { name: "fork", sourceBranchId: "main", sourceSeqId: accepted!.seqId });
		const forkAncestry = logStore.snapshot().ancestry("fork");
		const workspace = join(dir, "run", "workspaces", "fork");

		await materializeWorkspace(forkAncestry, store, workspace);

		await expect(readFile(join(workspace, "nested/report.md"), "utf8")).resolves.toBe("parent accepted bytes");
	});

	it("materializes only declared pinned paths and leaves unrelated files out", async () => {
		const dir = await root();
		const store = new ArtifactStore(join(dir, "run"));
		const source = join(dir, "declared.txt");
		await writeFile(source, "declared");
		await writeFile(join(dir, "undeclared.txt"), "must not travel");
		const pin = await store.put(source);
		const workspace = join(dir, "workspace");

		await materializeWorkspace([completion(1, "main", { "declared.txt": pin })], store, workspace);

		await expect(readFile(join(workspace, "declared.txt"), "utf8")).resolves.toBe("declared");
		await expect(readFile(join(workspace, "undeclared.txt"), "utf8")).rejects.toThrow();
	});

	it("skips an already matching target on repeated materialization", async () => {
		const dir = await root();
		const store = new ArtifactStore(join(dir, "run"));
		const source = join(dir, "state.txt");
		await writeFile(source, "stable");
		const pin = await store.put(source);
		const ancestry = [completion(1, "main", { "state.txt": pin })];
		const workspace = join(dir, "workspace");
		await materializeWorkspace(ancestry, store, workspace);
		const before = await stat(join(workspace, "state.txt"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		await materializeWorkspace(ancestry, store, workspace);

		const after = await stat(join(workspace, "state.txt"));
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it("reports both authored path and hash when a pinned object is missing", async () => {
		const dir = await root();
		const store = new ArtifactStore(join(dir, "run"));
		const hash = "a".repeat(64);

		await expect(materializeWorkspace(
			[completion(1, "main", { "missing/report.md": { hash, size: 12 } })],
			store,
			join(dir, "workspace"),
		)).rejects.toThrow(new RegExp(`missing/report\\.md.*${hash}|${hash}.*missing/report\\.md`));
	});
});
