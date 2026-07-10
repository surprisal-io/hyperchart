import { createContext, useContext } from "react";
import type { HyperchartUiTheme } from "../types.js";

export type HyperchartThemeContextValue = Required<HyperchartUiTheme>;

export const ThemeContext = createContext<HyperchartThemeContextValue>({ resolved: "dark", themeName: "base" });

export function useHyperchartTheme(): HyperchartThemeContextValue {
	return useContext(ThemeContext);
}
