import type { HyperchartStateInfo } from "../../../types.js";
import { typeAliasLines } from "../helpers/schema.js";
import { TypeSyntaxBlock } from "./TypeSyntaxBlock.js";

export function TypeBlock({
	schema,
	name,
	showOpenFull = true,
	stateId,
	highlightedPath,
}: {
	schema: HyperchartStateInfo["replySchema"];
	name: string;
	showOpenFull?: boolean;
	stateId?: string;
	highlightedPath?: string | null;
}) {
	const lines = typeAliasLines(schema, name, stateId, highlightedPath);
	if (!lines) return null;
	return <TypeSyntaxBlock lines={lines} showOpenFull={showOpenFull} />;
}
