import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "./doc-checks.mjs";

// Enumerates canonical documentation units and extracts the per-host tool-name
// registries straight from the tool definition sources, so guards check docs
// against what the code actually registers.

const DOC_ROOTS = ["docs"];
const EXTRA_UNITS = [
	"README.md",
	"packages/hyperchart/README.md",
	"packages/pi-hyperchart/README.md",
	"packages/claude-hyperchart/README.md",
];

function hostsFor(path) {
	if (path.includes("claude")) return "claude";
	if (path.endsWith("/pi.md") || path.includes("skills/pi") || path.endsWith("api/pi.md")) return "pi";
	if (path.startsWith("packages/pi-hyperchart/")) return "pi";
	return "both";
}

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (path.endsWith(".md")) yield path;
	}
}

const paths = [...DOC_ROOTS.flatMap((root) => [...walk(root)]), ...EXTRA_UNITS];
const items = {};
for (const path of paths.sort()) {
	const id = path.replace(/\.md$/, "").replaceAll("/", "-").toLowerCase();
	const text = readFileSync(path, "utf8");
	const title = text.match(/^#\s+(.+)$/m)?.[1] ?? path;
	items[id] = { id, path, hosts: hostsFor(path), title, bytes: text.length };
}

const extractNames = (file) =>
	[...new Set([...readFileSync(file, "utf8").matchAll(/name: "(hyperchart[a-z_]*)"/g)].map((match) => match[1]))].sort();
const registry = {
	claude: extractNames("packages/claude-hyperchart/src/mcp/tools.ts"),
	pi: extractNames("packages/pi-hyperchart/extensions/hyperchart.ts"),
};

mkdirSync("artifacts/docs-engine", { recursive: true });
writeFileSync("artifacts/docs-engine/units.json", `${JSON.stringify({ items }, null, 2)}\n`);
writeFileSync("artifacts/docs-engine/registry.json", `${JSON.stringify(registry, null, 2)}\n`);
emit("INVENTORY_READY", { items, unitCount: Object.keys(items).length, registry });
