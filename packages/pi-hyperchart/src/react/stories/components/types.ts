import type { StatePath } from "@surprisal/hyperchart/internal/core/types";
import type { HyperchartRunInfo } from "../../types.js";

export type RuntimeSourceBlock = {
	title: string;
	code: string;
	language?: string;
};

export type InspectorPanelTileProps =
	| {
			variant: "validation-error";
			title: string;
			message: string;
	  }
	| {
			variant: "panel";
			title: string;
			description: string;
			run: HyperchartRunInfo;
			selectedStateId: StatePath | null;
			definitionSource: string;
			runtimeSources: RuntimeSourceBlock[];
	  };
