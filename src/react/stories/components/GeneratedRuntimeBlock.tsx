import type { RuntimeSourceBlock } from "./types.js";
import { CodeBlock } from "./CodeBlock.js";

export function GeneratedRuntimeBlock({ title, code, language = "json" }: RuntimeSourceBlock) {
	return (
		<section className="min-w-0 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]">
			<div className="border-b border-[var(--border-primary)] px-3 py-2">
				<h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{title}</h4>
			</div>
			<div className="max-h-[320px] overflow-auto">
				<CodeBlock code={code} language={language} />
			</div>
		</section>
	);
}
