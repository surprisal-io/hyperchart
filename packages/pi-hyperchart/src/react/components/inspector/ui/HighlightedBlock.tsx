import React, { useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getSyntaxTheme } from "../../../support/syntax-theme.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";

export function HighlightedBlock({
	children,
	language,
	full = false,
}: {
	children: React.ReactNode;
	language?: string | undefined;
	full?: boolean;
}) {
	const { resolved, themeName } = useHyperchartTheme();
	const syntaxStyle = useMemo(() => getSyntaxTheme(resolved, themeName), [resolved, themeName]);
	const text = typeof children === "string" ? children : String(children ?? "");
	if (language) {
		return (
			<SyntaxHighlighter
				style={syntaxStyle}
				language={language}
				PreTag="div"
				customStyle={{
					margin: 0,
					width: "max-content",
					minWidth: "100%",
					padding: full ? "0.75rem" : "0.5rem",
					background: "var(--bg-code)",
					fontSize: full ? "0.75rem" : "0.7rem",
					lineHeight: 1.55,
				}}
				codeTagProps={{ style: { background: "transparent", whiteSpace: "pre", overflowWrap: "normal" } }}
			>
				{text}
			</SyntaxHighlighter>
		);
	}
	const preClassName = `${full ? "p-3 text-[12px] leading-relaxed" : "p-2 text-[11px]"} w-max min-w-full text-[var(--text-secondary)]`;
	return <pre className={`${preClassName} whitespace-pre [overflow-wrap:normal]`}>{children}</pre>;
}
