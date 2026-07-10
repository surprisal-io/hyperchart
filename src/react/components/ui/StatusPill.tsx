import { hyperchartStatusClasses, hyperchartStatusIcon } from "../../hyperchart-display.js";

export function StatusPill({ status }: { status: string }) {
	const StatusIcon = hyperchartStatusIcon(status);
	return (
		<span
			className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${hyperchartStatusClasses(status)}`}
		>
			<StatusIcon className={`h-3 w-3 ${status === "running" ? "animate-spin" : ""}`} aria-hidden="true" />
			{status}
		</span>
	);
}
