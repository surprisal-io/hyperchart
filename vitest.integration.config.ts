import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The same source aliases as the fast suite, but only the external-I/O, host,
// process and end-to-end tests. Run for affected subsystems or before release.
export default defineConfig({
	...base,
	test: {
		...base.test,
		include: ["tests/integration/**/*.test.ts"],
		exclude: ["dist/**", "node_modules/**"],
	},
});
