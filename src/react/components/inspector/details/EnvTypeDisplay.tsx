import type { HyperchartStateInfo } from "../../../types.js";
import { TypeBlock } from "../ui/TypeBlock.js";

export function EnvTypeDisplay({ env }: { env: NonNullable<HyperchartStateInfo["env"]>[number] }) {
	return (
		<div>
			<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">type</div>
			{env.schema ? (
				<div className="space-y-1">
					<TypeBlock schema={env.schema} name={`${env.name} env`} />
					<div className="text-[10px] text-[var(--text-muted)]">
						Encoded for the process environment as{" "}
						<code className="rounded bg-[var(--bg-code)] px-1 py-0.5">{env.type}</code>.
					</div>
				</div>
			) : (
				<code className="block max-w-full overflow-x-auto whitespace-pre rounded bg-[var(--bg-code)] px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)]">
					{env.type}
				</code>
			)}
		</div>
	);
}
