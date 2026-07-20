import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";
import { resolve } from "node:path";
import { tuiPreviewPlugin } from "./tui-preview-plugin.js";

const core = (path: string) => resolve(import.meta.dirname, "../packages/hyperchart/src", path);

const config: StorybookConfig = {
	stories: ["../packages/hyperchart/src/react/**/*.stories.@(ts|tsx)"],
	framework: {
		name: "@storybook/react-vite",
		options: {},
	},
	staticDirs: [],
	typescript: {
		check: false,
		reactDocgen: "react-docgen-typescript",
	},
	viteFinal(config) {
		config.plugins = [...(config.plugins ?? []), tailwindcss(), tuiPreviewPlugin()];
		config.resolve = {
			...config.resolve,
			alias: [
				...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : []),
				{ find: "@surprisal/hyperchart/host", replacement: core("host/index.ts") },
				{ find: "@surprisal/hyperchart/runtime", replacement: core("runtime/index.ts") },
				{ find: "@surprisal/hyperchart/inspect", replacement: core("inspect/index.ts") },
				{ find: "@surprisal/hyperchart/sessions", replacement: core("sessions/index.ts") },
				{ find: "@surprisal/hyperchart/react", replacement: core("react/index.ts") },
				{ find: /^@surprisal\/hyperchart\/internal\/core\/(.*)$/, replacement: core("core/$1.ts") },
				{ find: /^@surprisal\/hyperchart\/internal\/utils\/(.*)$/, replacement: core("utils/$1.ts") },
				{ find: /^@surprisal\/hyperchart$/, replacement: core("index.ts") },
			],
		};
		return config;
	},
};

export default config;
