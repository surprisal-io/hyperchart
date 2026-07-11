import React, { useContext } from "react";
import type { HyperchartUiTheme } from "../types.js";
import { ThemeContext } from "./theme-context.js";

export function HyperchartUiThemeProvider({
	children,
	theme,
}: {
	children: React.ReactNode;
	theme?: HyperchartUiTheme | undefined;
}) {
	const inherited = useContext(ThemeContext);
	return (
		<ThemeContext.Provider
			value={{ resolved: theme?.resolved ?? inherited.resolved, themeName: theme?.themeName ?? inherited.themeName }}
		>
			{children}
		</ThemeContext.Provider>
	);
}
