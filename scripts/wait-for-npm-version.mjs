import { spawnSync } from "node:child_process";

const [packageName, version, timeoutInput = "600"] = process.argv.slice(2);
const timeoutSeconds = Number(timeoutInput);

if (!packageName || !version || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
	throw new Error("Usage: node scripts/wait-for-npm-version.mjs <package> <version> [timeout-seconds]");
}

const startedAt = Date.now();
let attempt = 0;
let lastError = "not queried";

while ((Date.now() - startedAt) / 1000 < timeoutSeconds) {
	attempt += 1;
	const result = spawnSync(
		"npm",
		[
			"view",
			`${packageName}@${version}`,
			"version",
			"--json",
			"--registry=https://registry.npmjs.org/",
		],
		{ encoding: "utf8" },
	);
	const actual = parseVersion(result.stdout);
	if (result.status === 0 && actual === version) {
		console.log(`${packageName}@${version} is visible in the npm registry.`);
		process.exit(0);
	}

	lastError = result.stderr.trim() || result.stdout.trim() || `npm view exited ${String(result.status)}`;
	const elapsed = Math.round((Date.now() - startedAt) / 1000);
	console.log(
		`Waiting for ${packageName}@${version} to become visible (${elapsed}s/${timeoutSeconds}s, attempt ${attempt})...`,
	);
	await new Promise((resolve) => setTimeout(resolve, 5_000));
}

throw new Error(
	`${packageName}@${version} did not become visible within ${timeoutSeconds}s. Last npm response:\n${lastError}`,
);

function parseVersion(stdout) {
	const value = stdout.trim();
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "string" ? parsed : undefined;
	} catch {
		return value;
	}
}
