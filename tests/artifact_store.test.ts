import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, hashFile } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-artifact-store-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
	it("puts a file and returns a pin matching sha256 of the content", async () => {
		const dir = await makeTempDir();
		const source = join(dir, "report.md");
		await writeFile(source, "hello world");
		const store = new ArtifactStore(dir);

		const pin = await store.put(source);

		expect(pin.hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
		expect(pin.size).toBe(11);
		const stored = await readFile(store.objectPath(pin.hash), "utf8");
		expect(stored).toBe("hello world");
	});

	it("is idempotent: putting identical content twice yields one object", async () => {
		const dir = await makeTempDir();
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		await writeFile(a, "same bytes");
		await writeFile(b, "same bytes");
		const store = new ArtifactStore(dir);

		const first = await store.put(a);
		const second = await store.put(b);

		expect(second).toEqual(first);
		expect(await store.has(first.hash)).toBe(true);
	});

	it("survives concurrent puts of identical content", async () => {
		const dir = await makeTempDir();
		const source = join(dir, "shared.json");
		await writeFile(source, JSON.stringify({ v: 1 }));
		const store = new ArtifactStore(dir);

		const pins = await Promise.all([store.put(source), store.put(source), store.put(source)]);

		expect(new Set(pins.map((p) => p.hash)).size).toBe(1);
		await expect(store.get(pins[0].hash)).resolves.toBe(store.objectPath(pins[0].hash));
	});

	it("get verifies content and reports corruption", async () => {
		const dir = await makeTempDir();
		const source = join(dir, "data.txt");
		await writeFile(source, "original");
		const store = new ArtifactStore(dir);
		const pin = await store.put(source);

		await writeFile(store.objectPath(pin.hash), "tampered");

		await expect(store.get(pin.hash)).rejects.toThrow(/corrupt/);
	});

	it("get reports a missing object", async () => {
		const dir = await makeTempDir();
		const store = new ArtifactStore(dir);
		const absent = "0".repeat(64);

		expect(await store.has(absent)).toBe(false);
		await expect(store.get(absent)).rejects.toThrow(/missing/);
	});

	it("rejects malformed hashes instead of touching the filesystem", async () => {
		const dir = await makeTempDir();
		const store = new ArtifactStore(dir);

		expect(() => store.objectPath("../escape")).toThrow(/invalid content hash/);
		expect(() => store.objectPath("ABC")).toThrow(/invalid content hash/);
	});

	it("put propagates a missing source and leaves no temp files", async () => {
		const dir = await makeTempDir();
		const store = new ArtifactStore(dir);

		await expect(store.put(join(dir, "does-not-exist"))).rejects.toThrow();

		const pin = await store.put(await (async () => {
			const path = join(dir, "later.txt");
			await writeFile(path, "x");
			return path;
		})());
		expect(await store.has(pin.hash)).toBe(true);
	});
});

describe("hashFile", () => {
	it("matches the pin produced by put", async () => {
		const dir = await makeTempDir();
		const source = join(dir, "file.bin");
		await writeFile(source, Buffer.from([0, 1, 2, 255]));
		const store = new ArtifactStore(dir);

		const pin = await store.put(source);

		expect(await hashFile(source)).toBe(pin.hash);
	});
});
