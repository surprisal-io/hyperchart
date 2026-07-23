import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = check ? args[1] : args[0];

if (!version || !isValidVersion(version)) {
	throw new Error("Usage: node scripts/set-release-version.mjs [--check] <semver>");
}

const rootManifest = readJson("package.json");
const coreManifest = readJson("packages/hyperchart/package.json");
const piManifest = readJson("packages/pi-hyperchart/package.json");
const claudeManifest = readJson("packages/claude-hyperchart/package.json");
const pluginManifest = readJson("packages/claude-hyperchart/.claude-plugin/plugin.json");
const lockfile = readJson("package-lock.json");
const coreDependency = piManifest.dependencies?.[coreManifest.name];
const claudeCoreDependency = claudeManifest.dependencies?.[coreManifest.name];

if (check) {
	const mismatches = [];
	assertEqual("workspace version", rootManifest.version, version, mismatches);
	assertEqual("core package version", coreManifest.version, version, mismatches);
	assertEqual("Pi package version", piManifest.version, version, mismatches);
	assertEqual("Pi core dependency", coreDependency, version, mismatches);
	assertEqual("Claude package version", claudeManifest.version, version, mismatches);
	assertEqual("Claude core dependency", claudeCoreDependency, version, mismatches);
	assertEqual("Claude plugin manifest version", pluginManifest.version, version, mismatches);
	assertEqual("lockfile version", lockfile.version, version, mismatches);
	assertEqual("lockfile workspace version", lockfile.packages?.[""]?.version, version, mismatches);
	assertEqual("lockfile core version", lockfile.packages?.["packages/hyperchart"]?.version, version, mismatches);
	assertEqual("lockfile Pi version", lockfile.packages?.["packages/pi-hyperchart"]?.version, version, mismatches);
	assertEqual(
		"lockfile Pi core dependency",
		lockfile.packages?.["packages/pi-hyperchart"]?.dependencies?.[coreManifest.name],
		version,
		mismatches,
	);
	assertEqual(
		"lockfile Claude version",
		lockfile.packages?.["packages/claude-hyperchart"]?.version,
		version,
		mismatches,
	);
	assertEqual(
		"lockfile Claude core dependency",
		lockfile.packages?.["packages/claude-hyperchart"]?.dependencies?.[coreManifest.name],
		version,
		mismatches,
	);
	assertContains("README.md", `experimental version ${version}`, mismatches);
	assertContains("packages/hyperchart/README.md", `experimental \`${version}\``, mismatches);
	assertContains("packages/pi-hyperchart/README.md", `experimental \`${version}\``, mismatches);
	if (mismatches.length > 0) throw new Error(`Release version mismatch:\n${mismatches.join("\n")}`);
	console.log(`Release version ${version} is consistent.`);
	process.exit(0);
}

const currentVersions = new Set([
	rootManifest.version,
	coreManifest.version,
	piManifest.version,
	claudeManifest.version,
	pluginManifest.version,
]);
if (currentVersions.size !== 1) {
	throw new Error(`Current package versions differ: ${[...currentVersions].join(", ")}`);
}
const current = rootManifest.version;
if (coreDependency !== current) {
	throw new Error(`Pi package pins core ${coreDependency}; expected current version ${current}`);
}
if (claudeCoreDependency !== current) {
	throw new Error(`Claude package pins core ${claudeCoreDependency}; expected current version ${current}`);
}
if (current === version) throw new Error(`Version is already ${version}`);

lockfile.version = version;
lockfile.packages[""].version = version;
lockfile.packages["packages/hyperchart"].version = version;
lockfile.packages["packages/pi-hyperchart"].version = version;
lockfile.packages["packages/pi-hyperchart"].dependencies[coreManifest.name] = version;
lockfile.packages["packages/claude-hyperchart"].version = version;
lockfile.packages["packages/claude-hyperchart"].dependencies[coreManifest.name] = version;

replaceExact("package.json", `"version": "${current}"`, `"version": "${version}"`);
replaceExact(
	"packages/hyperchart/package.json",
	`"version": "${current}"`,
	`"version": "${version}"`,
);
replaceExact(
	"packages/pi-hyperchart/package.json",
	`"version": "${current}"`,
	`"version": "${version}"`,
);
replaceExact(
	"packages/pi-hyperchart/package.json",
	`"${coreManifest.name}": "${current}"`,
	`"${coreManifest.name}": "${version}"`,
);
replaceExact(
	"packages/claude-hyperchart/package.json",
	`"version": "${current}"`,
	`"version": "${version}"`,
);
replaceExact(
	"packages/claude-hyperchart/package.json",
	`"${coreManifest.name}": "${current}"`,
	`"${coreManifest.name}": "${version}"`,
);
replaceExact(
	"packages/claude-hyperchart/.claude-plugin/plugin.json",
	`"version": "${current}"`,
	`"version": "${version}"`,
);
writeJson("package-lock.json", lockfile);
replaceExact("README.md", `experimental version ${current}`, `experimental version ${version}`);
replaceExact(
	"packages/hyperchart/README.md",
	`experimental \`${current}\``,
	`experimental \`${version}\``,
);
replaceExact(
	"packages/pi-hyperchart/README.md",
	`experimental \`${current}\``,
	`experimental \`${version}\``,
);

console.log(`Updated release version ${current} -> ${version}.`);

function isValidVersion(value) {
	const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
	if (!match) return false;
	return !match[1]
		?.split(".")
		.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

function readJson(path) {
	return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function writeJson(path, value) {
	writeFileSync(resolve(root, path), `${JSON.stringify(value, null, "\t")}\n`);
}

function replaceExact(path, from, to) {
	const absolute = resolve(root, path);
	const source = readFileSync(absolute, "utf8");
	const first = source.indexOf(from);
	if (first < 0) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);
	if (source.indexOf(from, first + from.length) >= 0) {
		throw new Error(`${path} contains ${JSON.stringify(from)} more than once`);
	}
	writeFileSync(absolute, source.replace(from, to));
}

function assertEqual(label, actual, expected, mismatches) {
	if (actual !== expected) mismatches.push(`- ${label}: expected ${expected}, found ${String(actual)}`);
}

function assertContains(path, expected, mismatches) {
	if (!readFileSync(resolve(root, path), "utf8").includes(expected)) {
		mismatches.push(`- ${path}: missing ${JSON.stringify(expected)}`);
	}
}
