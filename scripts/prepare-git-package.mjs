import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const packageName = process.argv[2];
const entryByPackage = {
	"@surprisal/hyperchart": "packages/hyperchart/dist/index.js",
	"@surprisal/pi-hyperchart": "packages/pi-hyperchart/dist/command.js",
};
const entry = entryByPackage[packageName];
if (entry === undefined) throw new Error(`Unknown package '${packageName}'`);

const root = resolve(import.meta.dirname, "..");
try {
	await access(resolve(root, entry));
	process.exit(0);
} catch {}

run("npm", ["install", "--include=dev", "--ignore-scripts"], root);
if (packageName === "@surprisal/pi-hyperchart")
	run("npm", ["run", "build", "-w", "@surprisal/hyperchart"], root);
run("npm", ["run", "build", "-w", packageName], root);

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}
