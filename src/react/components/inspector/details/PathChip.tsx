export function PathChip({ value }: { value: string }) {
	return (
		<span
			title={value}
			className="block min-w-0 max-w-full truncate rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
			style={{ direction: "rtl", textAlign: "left" }}
		>
			{value}
		</span>
	);
}
