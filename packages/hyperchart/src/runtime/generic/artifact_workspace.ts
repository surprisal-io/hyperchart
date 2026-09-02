import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { ArtifactPin, DurableLogRecord } from "../../core/durable_events.js";
import type { RenderedArtifact } from "../../core/machine.js";
import { ArtifactStore, hashFile } from "./artifact_store.js";
import { renderedArtifactPath } from "./artifacts.js";

/** Latest accepted revision per rendered path along a normalized branch ancestry. */
export function latestPinsByPath(ancestry: readonly DurableLogRecord[]): ReadonlyMap<string, ArtifactPin> {
	const pins = new Map<string, ArtifactPin>();
	for (const record of ancestry) {
		if (record.type !== "state_action" || record.kind !== "complete" || record.artifacts === undefined) continue;
		for (const [path, pin] of Object.entries(record.artifacts)) pins.set(path, pin);
	}
	return pins;
}

/**
 * Materialize the accepted artifact state of one normalized branch ancestry.
 * Only pinned, authored paths travel; unrelated files already in the target are untouched.
 */
export async function materializeWorkspace(
	ancestry: readonly DurableLogRecord[],
	artifactStore: ArtifactStore,
	targetDir: string,
): Promise<void> {
	return materializeWorkspaceFromPins(latestPinsByPath(ancestry), artifactStore, targetDir);
}

/** Materialize directly from current projected pins without rescanning ancestry. */
export async function materializeWorkspaceFromPins(
	pins: ReadonlyMap<string, ArtifactPin> | Readonly<Record<string, ArtifactPin>>,
	artifactStore: ArtifactStore,
	targetDir: string,
): Promise<void> {
	await fsp.mkdir(targetDir, { recursive: true });
	const entries = pins instanceof Map ? pins : Object.entries(pins);
	for (const [authoredPath, pin] of entries) {
		const targetPath = renderedArtifactPath({ path: authoredPath } satisfies RenderedArtifact, targetDir);
		if (await matchesHash(targetPath, pin.hash)) continue;
		let sourcePath: string;
		try {
			sourcePath = await artifactStore.get(pin.hash);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot materialize artifact '${authoredPath}' at revision ${pin.hash}: ${detail}`);
		}
		await fsp.mkdir(dirname(targetPath), { recursive: true });
		await fsp.copyFile(sourcePath, targetPath);
	}
}

async function matchesHash(path: string, hash: string): Promise<boolean> {
	try {
		return (await hashFile(path)) === hash;
	} catch {
		return false;
	}
}
