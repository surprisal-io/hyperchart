import { access } from "node:fs/promises";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../packages/hyperchart");
const outputDir = resolve(root, "dist/inspector-web");
await build({
	root,
	logLevel: "warn",
	plugins: [tailwindcss()],
	build: {
		outDir: outputDir,
		emptyOutDir: true,
		cssMinify: true,
		rollupOptions: {
			input: resolve(root, "src/inspect/inspector-web-client.tsx"),
			output: {
				entryFileNames: "client.js",
				assetFileNames: "styles.css",
			},
		},
	},
});
await Promise.all([access(resolve(outputDir, "client.js")), access(resolve(outputDir, "styles.css"))]);
