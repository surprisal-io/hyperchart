import type { HyperchartStateInfo } from "../../../types.js";
import { FanoutStatusCard } from "./FanoutStatusCard.js";

export function CompactParallelNodePreview({ state }: { state: HyperchartStateInfo }) {
	return state.type === "parallel" ? <FanoutStatusCard state={state} compact /> : null;
}
