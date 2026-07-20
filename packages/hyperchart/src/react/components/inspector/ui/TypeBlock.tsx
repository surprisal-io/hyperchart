import type { HyperchartStateInfo } from "../../../types.js";
import { typeAliasLines } from "../helpers/schema.js";
import { TypeSyntaxBlock } from "./TypeSyntaxBlock.js";

export function TypeBlock({
	schema,
	name,
	stateId,
	highlightedPath,
}: {
	schema: HyperchartStateInfo["replySchema"];
	name: string;
	stateId?: string;
	highlightedPath?: string | null;
}) {
	const lines = typeAliasLines(schema, name, stateId, highlightedPath);
	if (!lines) return null;
	return <TypeSyntaxBlock lines={lines} />;
}
