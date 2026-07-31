import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/tag-release.mjs", import.meta.url));
let tempDir = "";

afterEach(() => {
	if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

describe("release tag script", () => {
	it("creates and idempotently pushes an annotated vVERSION tag", () => {
		const { work, remote } = createRepository();
		runNode([script, "1.2.3"], work);
		const head = git(["rev-parse", "HEAD"], work);

		expect(git(["cat-file", "-t", "refs/tags/v1.2.3"], work)).toBe("tag");
		expect(remoteTagCommit(remote, "v1.2.3")).toBe(head);
		expect(() => runNode([script, "1.2.3"], work)).not.toThrow();
	});

	it("rejects a release tag that points at another commit", () => {
		const { work } = createRepository();
		git(["tag", "-a", "v2.0.0", "-m", "old release"], work);
		writeFileSync(join(work, "file.txt"), "second\n", "utf8");
		git(["add", "file.txt"], work);
		git(["commit", "-m", "second"], work);

		expect(() => runNode([script, "--check", "2.0.0"], work)).toThrow(/points to .* expected current HEAD/);
	});

	it("rejects a lightweight release tag", () => {
		const { work } = createRepository();
		git(["tag", "v3.0.0"], work);

		expect(() => runNode([script, "--check", "3.0.0"], work)).toThrow(/is not annotated/);
	});

	it("rejects conflicting and lightweight tags already present on the remote", () => {
		const { work } = createRepository();
		git(["tag", "-a", "v4.0.0", "-m", "old release"], work);
		git(["push", "origin", "refs/tags/v4.0.0"], work);
		git(["tag", "-d", "v4.0.0"], work);
		writeFileSync(join(work, "file.txt"), "second\n", "utf8");
		git(["add", "file.txt"], work);
		git(["commit", "-m", "second"], work);
		git(["tag", "v4.1.0"], work);
		git(["push", "origin", "refs/tags/v4.1.0"], work);
		git(["tag", "-d", "v4.1.0"], work);

		expect(() => runNode([script, "--check", "4.0.0"], work)).toThrow(/points to .* expected current HEAD/);
		expect(() => runNode([script, "--check", "4.1.0"], work)).toThrow(/is not annotated/);
	});

	it("reuses the compatible local tag after a failed push", () => {
		const { work, remote } = createRepository();
		const hook = join(remote, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
		chmodSync(hook, 0o755);

		expect(() => runNode([script, "5.0.0"], work)).toThrow();
		expect(git(["cat-file", "-t", "refs/tags/v5.0.0"], work)).toBe("tag");
		unlinkSync(hook);
		expect(() => runNode([script, "5.0.0"], work)).not.toThrow();
		expect(remoteTagCommit(remote, "v5.0.0")).toBe(git(["rev-parse", "HEAD"], work));
	});

	it("rejects a non-semver tag version", () => {
		const { work } = createRepository();
		expect(() => runNode([script, "release"], work)).toThrow(/Invalid release version/);
	});
});

function createRepository(): { work: string; remote: string } {
	tempDir = mkdtempSync(join(tmpdir(), "hyperchart-release-tag-"));
	const remote = join(tempDir, "remote.git");
	const work = join(tempDir, "work");
	git(["init", "--bare", remote], tempDir);
	git(["init", work], tempDir);
	git(["config", "user.name", "Release Test"], work);
	git(["config", "user.email", "release@example.test"], work);
	writeFileSync(join(work, "file.txt"), "first\n", "utf8");
	git(["add", "file.txt"], work);
	git(["commit", "-m", "first"], work);
	git(["remote", "add", "origin", remote], work);
	git(["push", "-u", "origin", "HEAD:main"], work);
	return { work, remote };
}

function remoteTagCommit(remote: string, tag: string): string {
	const output = git(["ls-remote", "--tags", remote, `refs/tags/${tag}^{}`], tempDir);
	return output.split(/\s+/, 1)[0] ?? "";
}

function runNode(args: string[], cwd: string): string {
	try {
		return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		throw new Error(stderr);
	}
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
