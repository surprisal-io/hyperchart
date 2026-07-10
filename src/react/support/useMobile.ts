import { useEffect, useState } from "react";

export function useMobile(breakpointPx = 768): boolean {
	const [mobile, setMobile] = useState(() =>
		typeof window === "undefined" ? false : window.innerWidth < breakpointPx,
	);
	useEffect(() => {
		if (typeof window === "undefined") return undefined;
		const onResize = () => setMobile(window.innerWidth < breakpointPx);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [breakpointPx]);
	return mobile;
}
