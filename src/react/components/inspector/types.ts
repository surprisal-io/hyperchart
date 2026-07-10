import type { ElkPoint } from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import { UserCircleIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartStateType } from "../../types.js";

export type HeroIcon = typeof UserCircleIcon;

export interface StateNodeData extends Record<string, unknown> {
	state: HyperchartStateInfo;
	displayType?: HyperchartStateType;
	childPreview?: string;
}

export type StateNode = Node<StateNodeData>;

export type GraphLayout = { nodes: StateNode[]; edges: Edge[] };
export type NodePosition = { x: number; y: number };
export type RoutedEdgeData = { points?: ElkPoint[] };
export type ElkLayoutEngine = {
	layout: (graph: import("elkjs/lib/elk.bundled.js").ElkNode) => Promise<import("elkjs/lib/elk.bundled.js").ElkNode>;
};

export type TypeTreeLine = {
	text: string;
	highlight?: boolean;
	id?: string;
};

export type HyperchartBranch = NonNullable<NonNullable<HyperchartStateInfo["parallelConfig"]>["branches"]>[number];

export type FanoutStatusEntry = {
	key: string;
	label: string;
	status?: string | undefined;
	title?: string | undefined;
	issueCount?: number | undefined;
};

export type FanoutStatusSummary = {
	kind: "map" | "parallel";
	label: string;
	emptyLabel: string;
	emptyHint: string;
	total?: number | undefined;
	done: number;
	running: number;
	failed: number;
	pending: number;
	entries: FanoutStatusEntry[];
};

export type PromptInterpolationTone = "input" | "result" | "visit" | "plain";

export type PromptInterpolationAction = {
	title: string;
	tone: PromptInterpolationTone;
	onClick?: () => void;
};

export type PromptInterpolationRef =
	| { kind: "input"; name: string; path?: string }
	| { kind: "result"; state: string; path?: string }
	| { kind: "visit"; state?: string }
	| { kind: "key"; state?: string }
	| { kind: "unknown" };

export type InterpolatedTextProps = {
	text: string;
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
};

export type StateTransition = NonNullable<HyperchartStateInfo["transitions"]>[number];
export type StateInput = NonNullable<HyperchartStateInfo["inputs"]>[number];

export type EventBindingDisplay = { kind: "event"; path?: string } | { kind: "unknown"; preview: string };
