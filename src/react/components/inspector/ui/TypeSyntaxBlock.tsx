import { useMemo, useState } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getSyntaxTheme } from "../../../support/syntax-theme.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";
import type { TypeTreeLine } from "../types.js";
import { FullPreDialog } from "./FullPreDialog.js";

export function TypeSyntaxBlock({ lines, showOpenFull = true }: { lines: TypeTreeLine[]; showOpenFull?: boolean }) {
	const { resolved, themeName } = useHyperchartTheme();
	const syntaxStyle = useMemo(() => getSyntaxTheme(resolved, themeName), [resolved, themeName]);
	const [fullOpen, setFullOpen] = useState(false);
	const text = lines.map((line) => line.text).join("\n");
	return (
		<div className="relative w-full min-w-0 max-w-full space-y-1">
			<div className="w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)]">
				<SyntaxHighlighter
					style={syntaxStyle}
					language="typescript"
					PreTag="div"
					wrapLines
					showLineNumbers
					showInlineLineNumbers={false}
					lineNumberContainerStyle={{ display: "none" }}
					lineProps={(lineNumber) => {
						const line = typeof lineNumber === "number" ? lines[lineNumber - 1] : undefined;
						if (!line?.highlight) return {};
						return {
							...(line.id === undefined ? {} : { id: line.id }),
							style: {
								display: "block",
								borderRadius: "0.375rem",
								background: "rgba(245, 158, 11, 0.18)",
								boxShadow: "inset 0 0 0 1px rgba(245, 158, 11, 0.35)",
							},
						};
					}}
					customStyle={{
						margin: 0,
						width: "max-content",
						minWidth: "100%",
						padding: "0.5rem",
						background: "var(--bg-code)",
						fontSize: "0.7rem",
						lineHeight: 1.55,
					}}
					codeTagProps={{ style: { background: "transparent", whiteSpace: "pre", overflowWrap: "normal" } }}
				>
					{text}
				</SyntaxHighlighter>
			</div>
			{showOpenFull && (
				<button
					type="button"
					onClick={() => setFullOpen(true)}
					className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--hc-blue-text)] hover:underline"
				>
					<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" /> Open full
				</button>
			)}
			{fullOpen && (
				<FullPreDialog language="typescript" onClose={() => setFullOpen(false)}>
					{text}
				</FullPreDialog>
			)}
		</div>
	);
}
