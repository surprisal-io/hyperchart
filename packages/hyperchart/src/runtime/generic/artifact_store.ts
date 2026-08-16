import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactPin } from "../../core/durable_events.js";

export type { ArtifactPin };

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Flat content-addressable store inside a run directory. Objects are immutable
 * accepted artifact states; identity is the sha256 of the full content, so an
 * object is externally verifiable with `sha256sum`. Writes are copy-then-hash
 * with an atomic rename: the pin always references exactly the stored bytes.
 */
export class ArtifactStore {
	private readonly objectsDir: string;

	constructor(runDir: string) {
		this.objectsDir = join(runDir, "artifact_store", "objects");
	}

	/** Snapshot the file at sourcePath into the store. Idempotent and lock-free. */
	async put(sourcePath: string): Promise<ArtifactPin> {
		await fsp.mkdir(this.objectsDir, { recursive: true });
		const tempPath = join(this.objectsDir, `tmp-${randomBytes(8).toString("hex")}`);
		try {
			// Copy first, hash the copy: the pin references exactly the stored bytes
			// even if the source keeps changing underneath (agents are not controlled).
			await fsp.copyFile(sourcePath, tempPath);
			const hash = await hashFile(tempPath);
			const size = (await fsp.stat(tempPath)).size;
			const finalPath = this.objectPath(hash);
			await fsp.mkdir(dirname(finalPath), { recursive: true });
			try {
				// Identical content maps to the same path, so a concurrent put of the
				// same bytes is benign: first rename wins, the loser's temp is removed.
				await fsp.rename(tempPath, finalPath);
			} catch (error) {
				if (!(await this.has(hash))) throw error;
				await fsp.rm(tempPath, { force: true });
			}
			return { hash, size };
		} catch (error) {
			await fsp.rm(tempPath, { force: true });
			throw error;
		}
	}

	/** Return the path of a stored object after verifying its bytes still match the hash. */
	async get(hash: string): Promise<string> {
		const path = this.objectPath(hash);
		let actual: string;
		try {
			actual = await hashFile(path);
		} catch {
			throw new Error(`Artifact store: object ${hash} is missing`);
		}
		if (actual !== hash) {
			throw new Error(`Artifact store: object ${hash} is corrupt (content hashes to ${actual})`);
		}
		return path;
	}

	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(this.objectPath(hash));
			return true;
		} catch {
			return false;
		}
	}

	objectPath(hash: string): string {
		if (!HASH_PATTERN.test(hash)) {
			throw new Error(`Artifact store: invalid content hash '${hash}'`);
		}
		return join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
	}
}

export async function hashFile(path: string): Promise<string> {
	const hasher = createHash("sha256");
	await pipeline(createReadStream(path), async function* (source) {
		for await (const chunk of source) {
			hasher.update(chunk as Buffer);
		}
	});
	return hasher.digest("hex");
}
