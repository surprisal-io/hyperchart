import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";
import { tuiPreviewPlugin } from "./tui-preview-plugin.js";

const config: StorybookConfig = {
	stories: ["../packages/pi-hyperchart/src/react/**/*.stories.@(ts|tsx)"],
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
		return config;
	},
};

export default config;
