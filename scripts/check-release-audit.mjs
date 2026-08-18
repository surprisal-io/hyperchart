import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Advisories with no fix reachable from this dependency tree. Each entry must
// name the blocker so it is re-evaluated when the blocker moves.
const accepted = new Map();

let output;
try {
	output = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8" });
} catch (error) {
	if (typeof error.stdout !== "string" || error.stdout.length === 0) throw error;
	output = error.stdout;
}

const report = JSON.parse(output);
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		if (typeof via !== "object") continue;
		const id = via.url?.split("/").at(-1);
		if (id) advisories.set(id, `${via.name} (${via.severity}): ${via.title} — ${via.url}`);
	}
}

const unexpected = [...advisories].filter(([id]) => !accepted.has(id));
if (unexpected.length > 0) {
	throw new Error(
		`Release audit found advisories outside the accepted list:\n${unexpected.map(([, line]) => `- ${line}`).join("\n")}`,
	);
}

const stale = [...accepted.keys()].filter((id) => !advisories.has(id));
for (const id of stale) {
	console.log(`Accepted advisory ${id} no longer reported; remove it from scripts/check-release-audit.mjs.`);
}
console.log(`Release audit passed with ${advisories.size} accepted advisories.`);
