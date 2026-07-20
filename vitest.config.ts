import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const core = (path: string) => resolve(import.meta.dirname, "packages/hyperchart/src", path);

export default defineConfig({
	resolve: {
		// Tests import package sources by relative path; aliasing the published
		// specifiers onto the same sources keeps module-level singletons (e.g. the
		// inspector server) shared and removes the stale-dist hazard in tests.
		alias: [
			{ find: "@surprisal/hyperchart/host", replacement: core("host/index.ts") },
			{ find: "@surprisal/hyperchart/runtime", replacement: core("runtime/index.ts") },
			{ find: "@surprisal/hyperchart/inspect", replacement: core("inspect/index.ts") },
			{ find: "@surprisal/hyperchart/sessions", replacement: core("sessions/index.ts") },
			{ find: "@surprisal/hyperchart/react/styles.css", replacement: core("react/styles.css") },
			{ find: "@surprisal/hyperchart/react", replacement: core("react/index.ts") },
			{ find: /^@surprisal\/hyperchart\/internal\/core\/(.*)$/, replacement: core("core/$1.ts") },
			{ find: /^@surprisal\/hyperchart\/internal\/utils\/(.*)$/, replacement: core("utils/$1.ts") },
			{ find: /^@surprisal\/hyperchart$/, replacement: core("index.ts") },
		],
	},
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["dist/**", "node_modules/**"],
	},
});
