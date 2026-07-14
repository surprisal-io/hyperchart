import React, { useContext, useMemo } from "react";
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
	const value = useMemo(
		() => ({ resolved: theme?.resolved ?? inherited.resolved, themeName: theme?.themeName ?? inherited.themeName }),
		[theme?.resolved, theme?.themeName, inherited.resolved, inherited.themeName],
	);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
