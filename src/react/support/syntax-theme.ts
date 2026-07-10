import type { CSSProperties } from "react";
import {
	dracula,
	ghcolors,
	gruvboxDark,
	gruvboxLight,
	nightOwl,
	nord,
	oneDark,
	oneLight,
	solarizedDarkAtom,
	solarizedlight,
} from "react-syntax-highlighter/dist/esm/styles/prism/index.js";

export type SyntaxStyle = { [key: string]: CSSProperties };

const syntaxStyles: Record<string, SyntaxStyle> = {
	oneDark: oneDark as SyntaxStyle,
	oneLight: oneLight as SyntaxStyle,
	dracula: dracula as SyntaxStyle,
	nord: nord as SyntaxStyle,
	ghcolors: ghcolors as SyntaxStyle,
	nightOwl: nightOwl as SyntaxStyle,
	solarizedDarkAtom: solarizedDarkAtom as SyntaxStyle,
	solarizedlight: solarizedlight as SyntaxStyle,
	gruvboxDark: gruvboxDark as SyntaxStyle,
	gruvboxLight: gruvboxLight as SyntaxStyle,
};

const INNER_CODE_KEY = 'code[class*="language-"]';

export function stripTokenBackgrounds(style: SyntaxStyle): SyntaxStyle {
	const out: SyntaxStyle = {};
	for (const [selector, props] of Object.entries(style)) {
		if (selector.includes(".token") || selector === INNER_CODE_KEY) {
			const cloned = { ...(props as Record<string, unknown>) };
			delete cloned.background;
			delete cloned.backgroundColor;
			out[selector] = cloned as CSSProperties;
		} else {
			out[selector] = props;
		}
	}
	return out;
}

export function getSyntaxTheme(resolved: "light" | "dark", themeName = "base"): SyntaxStyle {
	const darkMap: Record<string, string> = {
		base: "oneDark",
		dracula: "dracula",
		nord: "nord",
		night: "nightOwl",
		solarized: "solarizedDarkAtom",
		gruvbox: "gruvboxDark",
	};
	const lightMap: Record<string, string> = {
		base: "oneLight",
		dracula: "ghcolors",
		nord: "ghcolors",
		night: "oneLight",
		solarized: "solarizedlight",
		gruvbox: "gruvboxLight",
	};
	const styleName = resolved === "light" ? lightMap[themeName] : darkMap[themeName];
	const style = styleName === undefined ? undefined : syntaxStyles[styleName];
	return stripTokenBackgrounds(style ?? (resolved === "light" ? (oneLight as SyntaxStyle) : (oneDark as SyntaxStyle)));
}
