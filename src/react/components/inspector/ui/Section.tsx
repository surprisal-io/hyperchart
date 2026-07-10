import React, { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { HeroIcon } from "../types.js";

export function Section({
	title,
	icon: SectionIcon,
	children,
	defaultOpen = true,
	forceOpen = false,
}: {
	title: string;
	icon?: HeroIcon;
	children: React.ReactNode;
	defaultOpen?: boolean;
	forceOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	useEffect(() => {
		if (forceOpen) setOpen(true);
	}, [forceOpen]);
	const DisclosureIcon = open ? ChevronDownIcon : ChevronRightIcon;
	return (
		<section className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)]">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)]"
			>
				<DisclosureIcon className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
				{SectionIcon && <SectionIcon className="h-3.5 w-3.5 text-[var(--hc-blue-text)]" aria-hidden="true" />}
				{title}
			</button>
			{open && (
				<div className="space-y-2 border-t border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
					{children}
				</div>
			)}
		</section>
	);
}
