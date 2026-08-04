import React, { useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { DialogPortal } from "../../../support/DialogPortal.js";
import { getSyntaxTheme } from "../../../support/syntax-theme.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";

type TooltipTriggerProps = React.HTMLAttributes<HTMLElement> & {
	ref?: React.Ref<HTMLElement>;
};

export function TypeTooltip({ text, children }: { text: string; children: React.ReactElement<TooltipTriggerProps> }) {
	const { resolved, themeName } = useHyperchartTheme();
	const syntaxStyle = useMemo(() => getSyntaxTheme(resolved, themeName), [resolved, themeName]);
	const ref = useRef<HTMLElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
	const show = () => {
		const rect = ref.current?.getBoundingClientRect();
		if (!rect) return;
		const maxBubbleWidth = Math.min(288, Math.max(180, window.innerWidth - 16));
		const center = rect.left + rect.width / 2;
		const left = Math.min(Math.max(center, maxBubbleWidth / 2 + 8), window.innerWidth - maxBubbleWidth / 2 - 8);
		const above = rect.top > 72;
		setPosition({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
	};
	const hide = () => setPosition(null);
	const targetsNestedTooltip = (target: EventTarget | null) => {
		const isolated = target instanceof Element ? target.closest("[data-hyperchart-tooltip-isolated]") : null;
		return isolated !== null && isolated !== ref.current;
	};
	const trigger = React.cloneElement(children, {
		ref,
		onPointerEnter: (event) => {
			children.props.onPointerEnter?.(event);
			targetsNestedTooltip(event.target) ? hide() : show();
		},
		onPointerMove: (event) => {
			children.props.onPointerMove?.(event);
			targetsNestedTooltip(event.target) ? hide() : show();
		},
		onPointerLeave: (event) => {
			children.props.onPointerLeave?.(event);
			hide();
		},
		onFocus: (event) => {
			children.props.onFocus?.(event);
			targetsNestedTooltip(event.target) ? hide() : show();
		},
		onBlur: (event) => {
			children.props.onBlur?.(event);
			hide();
		},
	});
	return (
		<>
			{trigger}
			{position && (
				<DialogPortal>
					<div
						data-hyperchart-root
						data-theme={resolved}
						role="tooltip"
						className="pointer-events-none fixed z-[1100] whitespace-pre-wrap break-words rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[10px] leading-relaxed text-[var(--text-primary)] shadow-xl ring-1 ring-black/10"
						style={{
							left: position.left,
							top: position.top,
							maxWidth: "min(18rem, calc(100vw - 1rem))",
							transform: position.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
						}}
					>
						<SyntaxHighlighter
							style={syntaxStyle}
							language="typescript"
							PreTag="div"
							wrapLongLines
							customStyle={{ margin: 0, padding: 0, background: "transparent", fontSize: "0.68rem", lineHeight: 1.45 }}
							codeTagProps={{ style: { background: "transparent", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
						>
							{text}
						</SyntaxHighlighter>
					</div>
				</DialogPortal>
			)}
		</>
	);
}
