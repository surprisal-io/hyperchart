import { ExpandablePre } from "./ExpandablePre.js";

export function JsonBlock({ value, previewLines = 12 }: { value: unknown; previewLines?: number }) {
	return (
		<ExpandablePre collapsedLines={previewLines} language="json">
			{JSON.stringify(value, null, 2)}
		</ExpandablePre>
	);
}
