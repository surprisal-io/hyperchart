import { ArchiveBoxIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { TypeTooltip } from "../ui/TypeTooltip.js";

export type ArtifactRowKind = "single" | "join" | "pin";

const ICON_TOOLTIPS: Record<ArtifactRowKind, string> = {
	single: "artifact",
	join: "joined artifact",
	pin: "pinned revision",
};

/**
 * The one artifact-channel row: declared reads, resolved reads, and pinned
 * deliverables all render through it so tooltips and click behavior stay
 * identical. `kind` selects the icon and accent; omit it for plain file rows.
 */
export function ArtifactRow({
	kind,
	label,
	detail,
	typeText,
	onClick,
}: {
	kind?: ArtifactRowKind;
	label: string;
	detail?: string;
	/** Row-level TypeTooltip content (e.g. the artifact's content type). */
	typeText?: string;
	onClick?: () => void;
}) {
	const accent = kind !== undefined;
	const Icon = kind === "join" ? RectangleStackIcon : ArchiveBoxIcon;
	const content = (
		<>
			<span className={`flex w-max items-center gap-1 whitespace-nowrap font-mono text-[10px] ${accent ? "text-[var(--hc-purple-text)]" : "text-[var(--text-secondary)]"}`}>
				{kind !== undefined && (
					<TypeTooltip text={ICON_TOOLTIPS[kind]}>
						<span data-hyperchart-tooltip-isolated data-artifact-read-kind={kind} className="inline-flex">
							<Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
						</span>
					</TypeTooltip>
				)}
				<span>{label}</span>
			</span>
			{detail !== undefined && <span className="w-max whitespace-nowrap font-mono text-[9px] text-[var(--text-muted)]">{detail}</span>}
		</>
	);
	const box = accent ? "border-purple-500/20 bg-purple-500/5" : "border-[var(--border-secondary)] bg-[var(--bg-tertiary)]";
	const trigger = onClick !== undefined ? (
		<button type="button" onClick={onClick} className={`flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border px-2 py-1.5 text-left hover:bg-purple-500/10 ${box}`}>
			{content}
		</button>
	) : (
		<div className={`flex w-full min-w-0 flex-col items-start overflow-x-auto rounded border px-2 py-1.5 ${box}`}>{content}</div>
	);
	return typeText === undefined ? trigger : <TypeTooltip text={typeText}>{trigger}</TypeTooltip>;
}
