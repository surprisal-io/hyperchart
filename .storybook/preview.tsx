import type { Preview } from "@storybook/react-vite";
import { HyperchartUiThemeProvider } from "../packages/hyperchart/src/react/support/HyperchartUiThemeProvider.js";
import { ThemeFrame } from "./ThemeFrame.js";
import "./storybook.css";

const preview: Preview = {
	initialGlobals: {
		colorScheme: "dark",
	},
	globalTypes: {
		colorScheme: {
			description: "Dashboard color scheme",
			toolbar: {
				title: "Scheme",
				icon: "circlehollow",
				items: [
					{ value: "dark", title: "Dark" },
					{ value: "light", title: "Light" },
				],
				dynamicTitle: true,
			},
		},
	},
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		options: {
			storySort: {
				order: [
					"Hyperchart",
					[
						"Inspector",
						["Dialog", "Graph", "State Details", "Runtime Section", "Run Strip", "Agent Session"],
						"Launch",
						"TUI",
					],
				],
			},
		},
	},
	decorators: [
		(Story, context) => {
			const resolved = context.globals.colorScheme === "light" ? "light" : "dark";
			return (
				<HyperchartUiThemeProvider theme={{ resolved, themeName: "base" }}>
					<ThemeFrame resolved={resolved}>
						<Story />
					</ThemeFrame>
				</HyperchartUiThemeProvider>
			);
		},
	],
};

export default preview;
