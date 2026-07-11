import { createContext } from "react";
import type { HyperchartPortalRenderer } from "../types.js";

export const PortalContext = createContext<HyperchartPortalRenderer | undefined>(undefined);
