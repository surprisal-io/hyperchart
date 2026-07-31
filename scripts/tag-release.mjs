import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const version = checkOnly ? args[1] : args[0];
const remote = process.env.RELEASE_REMOTE?.trim() || "origin";

if (!version) {
	console.error("Usage: node scripts/tag-release.mjs [--check] <version>");
	process.exit(2);
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
	throw new Error(`Invalid release version: ${version}`);
}

const tag = `v${version}`;
const head = git(["rev-parse", "HEAD"]);
const localTag = readLocalTag(tag);
const remoteTag = readRemoteTag(remote, tag);

assertCompatible("local", tag, localTag, head);
assertCompatible(`remote ${remote}`, tag, remoteTag, head);

if (checkOnly) {
	console.log(`Release tag ${tag} is available for ${head}.`);
	process.exit(0);
}

if (remoteTag?.commit === head) {
	console.log(`Release tag ${tag} already exists on ${remote} at ${head}.`);
	process.exit(0);
}

if (localTag === undefined) {
	git(["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" });
}
git(["push", remote, `refs/tags/${tag}`], { stdio: "inherit" });
console.log(`Created annotated release tag ${tag} and pushed it to ${remote}.`);

function assertCompatible(location, tagName, actual, expected) {
	if (actual !== undefined && actual.commit !== expected) {
		throw new Error(`Release tag ${tagName} on ${location} points to ${actual.commit}, expected current HEAD ${expected}`);
	}
	if (actual !== undefined && !actual.annotated) {
		throw new Error(`Release tag ${tagName} on ${location} exists but is not annotated`);
	}
}

function readLocalTag(tagName) {
	try {
		return {
			commit: git(["rev-list", "-n", "1", `refs/tags/${tagName}`]),
			annotated: git(["cat-file", "-t", `refs/tags/${tagName}`]) === "tag",
		};
	} catch {
		return undefined;
	}
}

function readRemoteTag(remoteName, tagName) {
	const output = git([
		"ls-remote",
		"--tags",
		remoteName,
		`refs/tags/${tagName}`,
		`refs/tags/${tagName}^{}`,
	]);
	if (output === "") return undefined;
	const refs = new Map(
		output.split("\n").map((line) => {
			const [commit, ref] = line.trim().split(/\s+/, 2);
			return [ref, commit];
		}),
	);
	const peeled = refs.get(`refs/tags/${tagName}^{}`);
	return {
		commit: peeled ?? refs.get(`refs/tags/${tagName}`),
		annotated: peeled !== undefined,
	};
}

function git(gitArgs, options = {}) {
	const output = execFileSync("git", gitArgs, {
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
	return typeof output === "string" ? output.trim() : "";
}
