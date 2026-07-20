import React, { useContext } from "react";
import { createPortal } from "react-dom";
import { PortalContext } from "./portal-context.js";

export type DialogPortalProps = {
	children: React.ReactNode;
};

export function DialogPortal({ children }: DialogPortalProps) {
	const renderer = useContext(PortalContext);
	if (renderer !== undefined) return <>{renderer(children)}</>;
	if (typeof document !== "undefined" && document.body !== null) {
		return createPortal(children, document.body);
	}
	return <>{children}</>;
}
