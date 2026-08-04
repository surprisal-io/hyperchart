import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [command, packageName] = process.argv.slice(2);

const resources = {
	pi: [
		["docs", "packages/pi-hyperchart/docs"],
		["examples", "packages/pi-hyperchart/examples"],
		["assets/readme/architecture.svg", "packages/pi-hyperchart/assets/readme/architecture.svg"],
		["skills/pi", "packages/pi-hyperchart/skills/hyperchart"],
	],
	claude: [
		["skills/claude", "packages/claude-hyperchart/skills/hyperchart"],
	],
};

if ((command !== "stage" && command !== "clean") || !(packageName in resources)) {
	throw new Error("Usage: node scripts/stage-package-resources.mjs <stage|clean> <pi|claude>");
}

for (const [sourcePath, targetPath] of resources[packageName]) {
	const source = resolve(root, sourcePath);
	const target = resolve(root, targetPath);
	if (command === "clean") {
		rmSync(target, { recursive: true, force: true });
		continue;
	}
	if (!existsSync(source)) throw new Error(`Missing canonical package resource: ${sourcePath}`);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
}

console.error(`${command === "stage" ? "Staged" : "Removed"} ${packageName} package resources.`);
