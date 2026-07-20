import type { ReactNode, ReactPortal } from "react";

export type * from "../host/index.js";

export interface HyperchartUiTheme {
	resolved?: "light" | "dark";
	themeName?: string;
}

export type HyperchartPortalRenderer = (children: ReactNode) => ReactPortal | ReactNode;
