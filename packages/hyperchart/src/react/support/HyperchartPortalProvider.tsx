import React, { useContext } from "react";
import type { HyperchartPortalRenderer } from "../types.js";
import { PortalContext } from "./portal-context.js";

export function HyperchartPortalProvider({
	children,
	portal,
}: {
	children: React.ReactNode;
	portal?: HyperchartPortalRenderer | undefined;
}) {
	const inherited = useContext(PortalContext);
	return <PortalContext.Provider value={portal ?? inherited}>{children}</PortalContext.Provider>;
}
