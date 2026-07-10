import type { HyperchartStateInfo } from "../../../types.js";
import { FanoutStatusCard } from "./FanoutStatusCard.js";

export function CompactMapNodePreview({ state }: { state: HyperchartStateInfo }) {
	return state.type === "map" ? <FanoutStatusCard state={state} compact /> : null;
}
