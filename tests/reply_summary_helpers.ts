import type { ReplySchemaSummary } from "../packages/hyperchart/src/host/summarize.js";

/** Construct a representative answer using only the serializable gate summary. */
export function answerFromReplySummary(summary: ReplySchemaSummary): unknown {
	if (summary.hasDefault && summary.defaultJson !== undefined) return JSON.parse(summary.defaultJson);
	if (summary.literalJson !== undefined) return JSON.parse(summary.literalJson);
	if ((summary.allowedValueJson?.length ?? 0) > 0) return JSON.parse(summary.allowedValueJson![0]!);
	if ((summary.alternatives?.length ?? 0) > 0) {
		if (summary.alternativeMode === "allOf") {
			const parts = summary.alternatives!.map(answerFromReplySummary);
			if (parts.every((part) => typeof part === "object" && part !== null && !Array.isArray(part))) return Object.assign({}, ...parts);
			return parts[0];
		}
		return answerFromReplySummary(summary.alternatives![0]!);
	}
	const type = summary.types.find((candidate) => candidate !== "null") ?? summary.types[0];
	if (type === "object") {
		return Object.fromEntries((summary.fields ?? [])
			.filter((field) => field.required)
			.map((field) => [field.name, answerFromReplySummary(field.value)]));
	}
	if (type === "array") {
		if (summary.tupleItems !== undefined) return summary.tupleItems.map(answerFromReplySummary);
		const count = Math.max(1, summary.constraints?.minItems ?? 0);
		return Array.from({ length: count }, () => answerFromReplySummary(summary.element ?? { types: ["any"] }));
	}
	if (type === "string") {
		const minimum = Math.max(1, summary.constraints?.minLength ?? 0);
		const pattern = summary.constraints?.pattern;
		if (pattern === "^[a-z]+$") return "x".repeat(minimum);
		return "x".repeat(minimum);
	}
	if (type === "integer" || type === "number") {
		let value = summary.constraints?.minimum ?? ((summary.constraints?.exclusiveMinimum ?? -1) + 1);
		const multiple = summary.constraints?.multipleOf;
		if (multiple !== undefined) value = Math.ceil(value / multiple) * multiple;
		return type === "integer" ? Math.ceil(value) : value;
	}
	if (type === "boolean") return true;
	if (type === "null") return null;
	return null;
}
