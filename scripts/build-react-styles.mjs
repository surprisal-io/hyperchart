import { access } from "node:fs/promises";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../packages/hyperchart");
const outputDir = resolve(root, "dist/react");
const outputFile = resolve(outputDir, "styles.css");
await build({
	root,
	logLevel: "warn",
	plugins: [tailwindcss()],
	build: {
		outDir: outputDir,
		emptyOutDir: false,
		cssMinify: true,
		rollupOptions: {
			input: resolve(root, "src/react/styles.css"),
			output: { assetFileNames: "styles.css", entryFileNames: "styles.js" },
		},
	},
});
await access(outputFile);
