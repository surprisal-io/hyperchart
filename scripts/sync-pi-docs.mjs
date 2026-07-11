import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");

const mappings = [
	["docs", "packages/pi-hyperchart/docs"],
	["examples", "packages/pi-hyperchart/examples"],
	["assets/readme/architecture.svg", "packages/pi-hyperchart/assets/readme/architecture.svg"],
];

if (check) {
	const errors = [];
	for (const [sourcePath, targetPath] of mappings) {
		compare(resolve(root, sourcePath), resolve(root, targetPath), errors);
	}
	if (errors.length > 0) {
		throw new Error(`Bundled Pi documentation is stale:\n${errors.map((error) => `- ${error}`).join("\n")}\nRun npm run sync:pi-docs.`);
	}
	console.error("Bundled Pi documentation matches the canonical documentation.");
} else {
	for (const [sourcePath, targetPath] of mappings) {
		const source = resolve(root, sourcePath);
		const target = resolve(root, targetPath);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, target, { recursive: true });
	}
	console.error("Synchronized canonical documentation into packages/pi-hyperchart.");
}

function compare(source, target, errors) {
	if (!existsSync(target)) {
		errors.push(`missing ${relative(root, target)}`);
		return;
	}

	const sourceStat = statSync(source);
	const targetStat = statSync(target);
	if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
		errors.push(`type mismatch at ${relative(root, target)}`);
		return;
	}

	if (!sourceStat.isDirectory()) {
		if (!readFileSync(source).equals(readFileSync(target))) {
			errors.push(`content differs at ${relative(root, target)}`);
		}
		return;
	}

	const sourceNames = readdirSync(source).sort();
	const targetNames = readdirSync(target).sort();
	for (const name of sourceNames) {
		if (!targetNames.includes(name)) errors.push(`missing ${relative(root, resolve(target, name))}`);
		else compare(resolve(source, name), resolve(target, name), errors);
	}
	for (const name of targetNames) {
		if (!sourceNames.includes(name)) errors.push(`unexpected ${relative(root, resolve(target, name))}`);
	}
}
