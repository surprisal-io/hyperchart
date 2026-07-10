import { ExpandablePre } from "./ExpandablePre.js";

export function JsonBlock({
	value,
	maxHeight = "max-h-48",
	showOpenFull = true,
}: {
	value: unknown;
	maxHeight?: string;
	showOpenFull?: boolean;
}) {
	return (
		<ExpandablePre collapsedMaxHeight={maxHeight} showToggle={false} showOpenFull={showOpenFull} language="json">
			{JSON.stringify(value, null, 2)}
		</ExpandablePre>
	);
}
