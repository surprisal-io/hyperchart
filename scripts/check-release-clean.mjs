import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

for (const args of [
	["diff", "--quiet", "--ignore-submodules", "--"],
	["diff", "--cached", "--quiet", "--ignore-submodules", "--"],
]) {
	try {
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	} catch {
		throw new Error("Release requires a clean tracked working tree and index");
	}
}

const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean)
	.filter((path) => !path.startsWith("tla/"));

if (untracked.length > 0) {
	throw new Error(`Release has unexpected untracked files:\n${untracked.map((path) => `- ${path}`).join("\n")}`);
}

console.log("Release working tree is clean.");
