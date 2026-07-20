import { useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getSyntaxTheme } from "../../support/syntax-theme.js";
import { useHyperchartTheme } from "../../support/theme-context.js";

export function CodeBlock({ code, language = "typescript" }: { code: string; language?: string }) {
	const { resolved, themeName } = useHyperchartTheme();
	const syntaxStyle = useMemo(() => getSyntaxTheme(resolved, themeName), [resolved, themeName]);
	return (
		<SyntaxHighlighter
			style={syntaxStyle}
			language={language}
			PreTag="div"
			wrapLongLines
			customStyle={{
				margin: 0,
				padding: "0.75rem",
				background: "var(--bg-code)",
				fontSize: "0.7rem",
				lineHeight: 1.55,
			}}
			codeTagProps={{ style: { background: "transparent", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
		>
			{code}
		</SyntaxHighlighter>
	);
}
