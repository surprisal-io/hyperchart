import type { HyperchartStateInfo } from "../../../types.js";
import type { TypeTreeLine } from "../types.js";

type JsonSchemaRecord = Record<string, unknown>;

export function asSchemaRecord(value: unknown): JsonSchemaRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchemaRecord) : undefined;
}

function literalTs(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return "unknown";
}

function typeAliasName(raw: string): string {
	const words = raw.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
	const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("") || "Schema";
	return /^\d/.test(name) ? `T${name}` : name;
}

function propertyNameTs(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function schemaUnion(items: unknown, depth: number): string | undefined {
	if (!Array.isArray(items) || items.length === 0) return undefined;
	return items.map((item) => schemaToTs(item, depth)).join(" | ");
}

function schemaObjectToTs(schema: JsonSchemaRecord, depth: number): string {
	const properties = asSchemaRecord(schema.properties) ?? {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
	);
	const additional = schema.additionalProperties;
	const entries = Object.entries(properties);
	const pad = "  ".repeat(depth);
	const inner = "  ".repeat(depth + 1);
	const lines = entries.map(
		([key, value]) => `${inner}${propertyNameTs(key)}${required.has(key) ? "" : "?"}: ${schemaToTs(value, depth + 1)};`,
	);
	if (additional !== false) {
		const additionalSchema = asSchemaRecord(additional);
		const additionalType =
			additionalSchema && Object.keys(additionalSchema).length > 0
				? schemaToTs(additionalSchema, depth + 1)
				: "unknown";
		if (entries.length === 0) return `Record<string, ${additionalType}>`;
		lines.push(`${inner}[key: string]: ${additionalType};`);
	}
	if (lines.length === 0) return "Record<string, unknown>";
	return `{\n${lines.join("\n")}\n${pad}}`;
}

export function schemaToTs(value: unknown, depth = 0): string {
	const schema = asSchemaRecord(value);
	if (!schema) return "unknown";
	const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
	if (enumValues?.length) return enumValues.map(literalTs).join(" | ");
	if ("const" in schema) return literalTs(schema.const);
	const anyOf = schemaUnion(schema.anyOf, depth);
	if (anyOf) return anyOf;
	const oneOf = schemaUnion(schema.oneOf, depth);
	if (oneOf) return oneOf;
	const allOf = schemaUnion(schema.allOf, depth);
	if (allOf) return allOf.replace(/ \| /g, " & ");
	const type = schema.type;
	if (Array.isArray(type)) return type.map((item) => schemaToTs({ ...schema, type: item }, depth)).join(" | ");
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	if (type === "array") return `Array<${schemaToTs(schema.items, depth + 1)}>`;
	if (type === "object" || schema.properties || schema.additionalProperties) return schemaObjectToTs(schema, depth);
	return "unknown";
}

export function schemaInfoToTs(schema: HyperchartStateInfo["replySchema"], name: string): string | undefined {
	if (!schema) return undefined;
	const alias = typeAliasName(name);
	if (schema.schema) return `type ${alias} = ${schemaToTs(schema.schema, 0)};`;
	if (schema.schemaName) return `type ${alias} = ${schema.schemaName};`;
	return undefined;
}

function typeLinesForSchema(
	value: unknown,
	options: { stateId?: string; highlightedPath?: string | null; dataPath?: string },
	depth = 0,
): TypeTreeLine[] {
	const schema = asSchemaRecord(value);
	if (!schema) return [{ text: "unknown" }];
	const properties = asSchemaRecord(schema.properties);
	const additional = schema.additionalProperties;
	if ((schema.type === "object" || properties || additional) && properties) {
		const required = new Set(
			Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
		);
		const entries = Object.entries(properties);
		const pad = "  ".repeat(depth);
		const inner = "  ".repeat(depth + 1);
		const lines: TypeTreeLine[] = [{ text: "{" }];
		for (const [key, child] of entries) {
			const fieldPath = joinJsonPath(options.dataPath ?? "", key);
			const childLines = typeLinesForSchema(child, { ...options, dataPath: fieldPath }, depth + 1);
			const prefix = `${inner}${propertyNameTs(key)}${required.has(key) ? "" : "?"}: `;
			const highlight = options.highlightedPath === fieldPath;
			const id = highlight && options.stateId ? replyFieldElementId(options.stateId, fieldPath) : undefined;
			if (childLines.length === 1) {
				lines.push({
					text: `${prefix}${childLines[0]?.text ?? "unknown"};`,
					highlight,
					...(id === undefined ? {} : { id }),
				});
			} else {
				lines.push({
					text: `${prefix}${childLines[0]?.text ?? "unknown"}`,
					highlight,
					...(id === undefined ? {} : { id }),
				});
				lines.push(
					...childLines
						.slice(1, -1)
						.map((line) => ({ ...line, ...(highlight || line.highlight ? { highlight: true } : {}) })),
				);
				const last = childLines.at(-1)?.text ?? "}";
				lines.push({ text: `${last};`, highlight });
			}
		}
		if (additional !== false) {
			const additionalSchema = asSchemaRecord(additional);
			const additionalType =
				additionalSchema && Object.keys(additionalSchema).length > 0
					? schemaToTs(additionalSchema, depth + 1)
					: "unknown";
			if (entries.length === 0) return [{ text: `Record<string, ${additionalType}>` }];
			lines.push({ text: `${inner}[key: string]: ${additionalType};` });
		}
		if (lines.length === 1) return [{ text: "Record<string, unknown>" }];
		lines.push({ text: `${pad}}` });
		return lines;
	}
	return [{ text: schemaToTs(schema, depth) }];
}

export function typeAliasLines(
	schema: HyperchartStateInfo["replySchema"],
	name: string,
	stateId?: string,
	highlightedPath?: string | null,
): TypeTreeLine[] | undefined {
	if (!schema) return undefined;
	const alias = typeAliasName(name);
	if (!schema.schema) return schema.schemaName ? [{ text: `type ${alias} = ${schema.schemaName};` }] : undefined;
	const body = typeLinesForSchema(schema.schema, {
		...(stateId === undefined ? {} : { stateId }),
		...(highlightedPath === undefined ? {} : { highlightedPath }),
	});
	if (body.length === 1) return [{ ...body[0], text: `type ${alias} = ${body[0]?.text ?? "unknown"};` }];
	return [
		{ text: `type ${alias} = ${body[0]?.text ?? "{"}` },
		...body.slice(1, -1),
		{ text: `${body.at(-1)?.text ?? "}"};` },
	];
}

export function schemaLabel(schema: HyperchartStateInfo["replySchema"]): string {
	if (!schema) return "schema";
	if (schema.schemaName) return schema.schemaName;
	const root = schema.schema;
	const title = typeof root?.title === "string" ? root.title : undefined;
	const type = typeof root?.type === "string" ? root.type : undefined;
	return title ?? type ?? "json schema";
}

export function refEntries(refs: HyperchartStateInfo["refs"]): Array<{ kind: string; values: string[] }> {
	if (!refs) return [];
	return Object.entries(refs).flatMap(([kind, values]) =>
		Array.isArray(values) && values.length > 0 ? [{ kind, values }] : [],
	);
}

export function safeDomId(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

export function replySectionElementId(stateId: string): string {
	return `hc-reply-section-${safeDomId(stateId)}`;
}

export function replyFieldElementId(stateId: string, path: string): string {
	return `hc-reply-field-${safeDomId(stateId)}-${safeDomId(path)}`;
}

export function inputTypeElementId(stateId: string, name: string): string {
	return `hc-input-type-${safeDomId(stateId)}-${safeDomId(name)}`;
}

export function refValueElementId(stateId: string, value: string): string {
	return `hc-ref-value-${safeDomId(stateId)}-${safeDomId(value)}`;
}

export function schemaAtPath(
	schema: HyperchartStateInfo["replySchema"],
	path: string | undefined,
): HyperchartStateInfo["replySchema"] | undefined {
	const root = schema?.schema;
	if (!root) return undefined;
	if (path === undefined) return { schema: root };
	let current: unknown = root;
	for (const segment of path.split(".")) {
		const record = asSchemaRecord(current);
		const properties = asSchemaRecord(record?.properties);
		if (!properties || !(segment in properties)) return undefined;
		current = properties[segment];
	}
	const field = asSchemaRecord(current);
	return field ? { schema: field } : undefined;
}

export function schemaTypeText(schema: HyperchartStateInfo["replySchema"]): string {
	if (!schema) return "unknown";
	if (schema.schema) return schemaToTs(schema.schema, 0);
	return schema.schemaName ?? "schema";
}

export function joinJsonPath(parent: string, key: string): string {
	return parent ? `${parent}.${key}` : key;
}
