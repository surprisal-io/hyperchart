import type { HyperchartStateInfo } from "../../../types.js";
import { schemaAtPath } from "./schema.js";

export function parseDslCallArgs(token: string, name: string): string[] | undefined {
	const trimmed = token.trim();
	const prefix = `${name}(`;
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith(")")) {
		return undefined;
	}
	const body = trimmed.slice(prefix.length, -1).trim();
	if (body.length === 0) {
		return [];
	}
	const args: string[] = [];
	let rest = body;
	while (rest.length > 0) {
		const match = /^"((?:\\.|[^"\\])*)"\s*(?:,\s*|$)/.exec(rest);
		if (!match) {
			return undefined;
		}
		try {
			args.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
		} catch {
			return undefined;
		}
		rest = rest.slice(match[0].length);
	}
	return args;
}

export function stateInputRefSchema(
	state: HyperchartStateInfo,
	name: string,
	path?: string,
): HyperchartStateInfo["replySchema"] | undefined {
	const schema = state.inputs?.find((input) => input.name === name)?.schema;
	if (!schema) {
		return undefined;
	}
	return schemaAtPath(schema, path) ?? schema;
}
