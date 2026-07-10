import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
	stories: ["../src/react/**/*.stories.@(ts|tsx)"],
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
		config.plugins = [...(config.plugins ?? []), tailwindcss()];
		return config;
	},
};

export default config;
