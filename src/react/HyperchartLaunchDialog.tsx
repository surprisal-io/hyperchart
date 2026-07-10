import { HyperchartLaunchDialogInner } from "./components/launch/HyperchartLaunchDialogInner.js";
import type { HyperchartLaunchDialogProps } from "./components/launch/dialog-props.js";
import { HyperchartPortalProvider } from "./support/HyperchartPortalProvider.js";

export type { HyperchartLaunchDialogProps } from "./components/launch/dialog-props.js";

export function HyperchartLaunchDialog(props: HyperchartLaunchDialogProps) {
	const { portal, ...inner } = props;
	return (
		<HyperchartPortalProvider portal={portal}>
			<HyperchartLaunchDialogInner {...inner} />
		</HyperchartPortalProvider>
	);
}
