import type { HyperchartInspectResult, HyperchartInspectState } from "../core/inspect_ast.js";
import type { SchemaAst } from "../core/types.js";
import type { HyperchartRunInfo, HyperchartStateInfo } from "./models.js";

const PREVIEW_CHARS = 160;
const MAX_SUMMARY_STATES = 80;
const MAX_NESTED_ITEMS = 20;
const MAX_REPLY_SCHEMA_DEPTH = 12;
const MAX_REPLY_SCHEMA_NODES = 160;
const MAX_REPLY_SCHEMA_COLLECTION_ITEMS = 40;
const MAX_REPLY_SCHEMA_SUMMARY_BYTES = 20 * 1024;
const MAX_REPLY_SCHEMA_STRING_CHARS = 2_000;
const MAX_REPLY_DEFAULT_BYTES = 2_000;
const MAX_USER_GATE_IDENTITY_CHARS = 2_000;
const MAX_USER_GATE_COLLECTION_ITEMS = 40;
const MAX_USER_GATE_SUMMARY_BYTES = 48 * 1024;
const SUMMARY_TARGET_BYTES = 48 * 1024;
export const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;

/*
 * This is deliberately a positive wire contract. Adding a model-facing field
 * requires an explicit review here; unknown aliases do not become safe merely
 * because their spelling was absent from a denylist.
 */
const MODEL_ENVELOPE_FIELDS = new Set([
	"actionKey", "actionName", "active", "additionalProperties", "additionalValue", "agent", "agentDefinitionUnavailable", "allowedEvents",
	"allowedValueJson", "alternativeMode", "alternatives", "artifactWarningCount", "artifactWarnings", "artifacts", "attached", "attempts",
	"boundary", "branchId", "branches", "cacheRead", "cacheWrite", "chartId", "chartName", "chartPath", "charts", "committed", "constraints", "customType",
	"completedEvent", "concurrency", "content", "cost", "createdAt", "currentTool", "cwd", "defaultJson", "details",
	"deliveryNotice", "description", "digest", "display", "done", "element", "error", "errorPreview", "event", "exitCode", "exportName", "failed", "fields", "final",
	"finalOutputPreview", "format", "hasDefault", "id", "idempotent", "initial", "input", "instruction", "interaction", "isError", "issues",
	"headSeqId", "kind", "lastMessage", "limitation", "literalJson", "mapKey", "maxBytes", "maxContains", "maxItems", "maxLength", "maximum", "maxProperties", "message", "minContains", "minItems", "minLength", "minimum", "minProperties", "mode", "model", "multipleOf", "name", "not", "nullable", "omittedAllowedEventCount",
	"omittedArtifactCount", "omittedArtifactWarningCount", "omittedChartCount", "omittedIssueCount",
	"omittedOptionCount", "omittedPendingStateCount", "omittedPromptChars", "omittedReadCount", "omittedRegionCount",
	"omittedRemovedByStateCount", "omittedResolvedToolCount", "omittedRunCount", "omittedStateCount", "omittedStoppedCount",
	"omittedToolCount", "omittedTransitionCount", "omittedUnavailableAgentCount", "omittedQueuedCount",
	"onReject", "open", "optional", "options", "originalBytes", "originalChars", "omittedChars", "outcome", "output", "outputHint", "outputRequired", "over", "path", "pattern", "pendingStateIds",
	"pid", "presentation", "preservedRecords", "previousHeadSeqId", "preview", "projectChartsDir", "promptPreview", "propertyNames", "queued", "queuedCount", "reads", "records", "regions", "label",
	"removedByState", "replayWarningCount", "requestId", "required", "resolvedModel", "resolvedTools",
	"retries", "role", "runDir", "runId", "runs", "running", "scope", "seqId", "sessionDigest",
	"selectedBranchChanged", "severity", "sourceBranchId", "stale", "started", "state", "stateCount", "stateDigests", "stateId", "status", "stopped", "stoppedCount",
	"subProgress", "target", "targetLabel", "text", "thinking", "toolCount", "tools", "toolset", "total", "totalUsage", "tupleItems",
	"tokenCount", "transitionDigests", "turnCount", "type", "types", "unavailableAgents", "uniqueItems", "updatedAt", "updates", "url", "userChartsDir", "userInteractions", "value",
	"validationAttempts", "version", "visitCount", "waitedRun", "waiting", "exclusiveMinimum", "exclusiveMaximum", "contains", "minCount", "maxCount",
]);

/** A payload checked against the positive wire contract and byte cap. */
export type SafeToolPayload<T> = T & { readonly __safeToolPayload?: never };

/** Browser inspector HTTP responses deliberately do not pass through this contract. */
export function assertToolPayloadSafe<T>(payload: T): asserts payload is SafeToolPayload<T> {
	const json = inspectModelEnvelope(payload);
	const bytes = payloadBytes(json);
	if (bytes > MAX_TOOL_PAYLOAD_BYTES) {
		throw new Error(`Hyperchart model envelope exceeds ${MAX_TOOL_PAYLOAD_BYTES} bytes (${bytes})`);
	}
}

/** Validate the complete envelope and return it, or a deterministic bounded fallback on byte overflow. */
export function boundedModelEnvelope<T>(
	payload: T,
	fallback: (info: { digest: string; originalBytes: number; maxBytes: number }) => T,
): T {
	const json = inspectModelEnvelope(payload);
	const originalBytes = payloadBytes(json);
	if (originalBytes <= MAX_TOOL_PAYLOAD_BYTES) return payload;
	const replacement = fallback({ digest: digestText(json), originalBytes, maxBytes: MAX_TOOL_PAYLOAD_BYTES });
	assertToolPayloadSafe(replacement);
	return replacement;
}

/** Serialize a complete model-facing envelope after positive validation. */
export function serializeModelEnvelope<T>(
	payload: T,
	fallback: (info: { digest: string; originalBytes: number; maxBytes: number }) => T,
): string {
	return JSON.stringify(boundedModelEnvelope(payload, fallback));
}

/** Serialize a payload value. Prefer serializeModelEnvelope for a real boundary. */
export function serializeToolPayload<T>(payload: T): string {
	assertToolPayloadSafe(payload);
	return JSON.stringify(payload);
}

function inspectModelEnvelope(payload: unknown): string {
	visitPayload(payload, new Set(), "$", false);
	const json = JSON.stringify(payload);
	if (json === undefined) throw new Error("Hyperchart model envelope is not JSON serializable");
	return json;
}

function visitPayload(value: unknown, seen: Set<object>, path: string, inArray: boolean): void {
	if (value === undefined && !inArray) return; // JSON object serialization omits undefined fields.
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Hyperchart model envelope contains a non-finite number at ${path}`);
		return;
	}
	if (typeof value !== "object") throw new Error(`Hyperchart model envelope contains unsupported ${typeof value} at ${path}`);
	if (seen.has(value)) throw new Error(`Hyperchart model envelope contains a circular value at ${path}`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) visitPayload(value[index], seen, `${path}[${index}]`, true);
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`Hyperchart model envelope contains a non-plain object at ${path}`);
		for (const [key, child] of Object.entries(value)) {
			if (!MODEL_ENVELOPE_FIELDS.has(key)) throw new Error(`Hyperchart model envelope field '${key}' is not allowlisted at ${path}`);
			visitPayload(child, seen, `${path}.${key}`, false);
		}
	}
	seen.delete(value);
}

export type DisplayStringSummary = {
	text: string;
	originalChars: number;
	omittedChars: number;
};

export type UserGateOptionSummary = {
	/** Human-facing text; it may be truncated, with explicit character accounting. */
	label: DisplayStringSummary;
	/** Exact authored value. Never truncated. */
	value: string;
};

export type UserGateSummary = {
	version: 1;
	/** Exact public response coordinate. Never truncated. */
	runId: string;
	branchId: string;
	seqId: number;
	promptPreview: DisplayStringSummary;
	options: UserGateOptionSummary[];
	/** Exact non-FAILED event identities accepted by respond. Never truncated or dropped. */
	allowedEvents: string[];
	outputRequired: boolean;
	outputHint?: ReplyContractSummary["outputHint"];
};

export function summarizeUserGate(request: {
	runId: string;
	branchId: string;
	seqId: number;
	prompt: string;
	options: readonly string[];
	events: readonly string[];
	reply?: SchemaAst;
}): UserGateSummary {
	assertGateIdentity(request.runId, "$/runId");
	assertGateIdentity(request.branchId, "$/branchId");
	if (!Number.isSafeInteger(request.seqId) || request.seqId <= 0) {
		throw gateSummaryError(`Gate coordinate seqId must be a positive safe integer; received ${String(request.seqId)}`, "$/seqId", "identity");
	}
	checkGateCollection(request.options, "$/options", "options");
	const allowedEvents = request.events.filter((event) => event !== "FAILED");
	checkGateCollection(allowedEvents, "$/allowedEvents", "allowedEvents");
	for (const [index, event] of allowedEvents.entries()) assertGateIdentity(event, `$/allowedEvents/${index}`);
	for (const [index, option] of request.options.entries()) assertGateIdentity(option, `$/options/${index}/value`);

	const contract = summarizeReplyContract(request.reply);
	const summary: UserGateSummary = {
		version: 1,
		runId: request.runId,
		branchId: request.branchId,
		seqId: request.seqId,
		promptPreview: displayString(request.prompt, 1_000),
		options: request.options.map((value) => ({ label: displayString(value), value })),
		allowedEvents,
		outputRequired: contract !== undefined,
		...(contract === undefined ? {} : { outputHint: contract.outputHint }),
	};
	let bytes: number;
	try {
		assertToolPayloadSafe(summary);
		bytes = payloadBytes(JSON.stringify(summary));
	} catch (error) {
		throw gateSummaryError(`Gate summary is not safe for the model envelope: ${error instanceof Error ? error.message : String(error)}`, "$", "bytes");
	}
	if (bytes > MAX_USER_GATE_SUMMARY_BYTES) {
		throw new ReplyContractSummaryError(
			`Gate summary exceeds its ${MAX_USER_GATE_SUMMARY_BYTES}-byte cap (${bytes} bytes).`,
			{ path: "$", limit: "bytes", omittedCount: bytes - MAX_USER_GATE_SUMMARY_BYTES },
		);
	}
	return summary;
}

export type ReplySchemaConstraints = {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: true;
	minProperties?: number;
	maxProperties?: number;
	minContains?: number;
	maxContains?: number;
};

export type ReplySchemaSummary = {
	types: string[];
	nullable?: true;
	literalJson?: string;
	allowedValueJson?: string[];
	hasDefault?: true;
	defaultJson?: string;
	fields?: Array<{ name: string; required: boolean; optional: boolean; value: ReplySchemaSummary }>;
	additionalProperties?: "allowed" | "forbidden" | "schema";
	additionalValue?: ReplySchemaSummary;
	propertyNames?: ReplySchemaSummary;
	element?: ReplySchemaSummary;
	tupleItems?: ReplySchemaSummary[];
	contains?: ReplySchemaSummary;
	alternatives?: ReplySchemaSummary[];
	alternativeMode?: "anyOf" | "oneOf" | "allOf";
	not?: ReplySchemaSummary;
	constraints?: ReplySchemaConstraints;
};

export type ReplyContractSummary = {
	outputRequired: true;
	outputHint: ReplySchemaSummary;
};

export class ReplyContractSummaryError extends Error {
	readonly code = "REPLY_CONTRACT_SUMMARY_UNAVAILABLE";
	constructor(
		message: string,
		readonly metadata: { path: string; limit: "depth" | "nodes" | "bytes" | "collection" | "string" | "identity" | "unsupported"; collection?: string; omittedCount?: number },
	) {
		super(`${message} Cannot safely deliver this user gate through a model tool. Open the browser inspector and complete the user interaction there.`);
		this.name = "ReplyContractSummaryError";
	}
}

/** Non-executable, recursively bounded guidance sufficient to construct a schema-valid JSON value. */
export function summarizeReplyContract(reply: SchemaAst | undefined): ReplyContractSummary | undefined {
	if (reply === undefined) return undefined;
	if (reply.runtimeContract !== undefined) {
		throw summaryError("Exact runtime validation can contain constraints that are not serializable", "$", "unsupported");
	}
	const context: ReplySummaryContext = { root: reply.schema, nodes: 0, refs: new Set() };
	const outputHint = summarizeReplySchema(reply.schema, "$", 0, context);
	const summary = { outputRequired: true as const, outputHint };
	const bytes = payloadBytes(JSON.stringify(summary));
	if (bytes > MAX_REPLY_SCHEMA_SUMMARY_BYTES) {
		throw new ReplyContractSummaryError(
			`Reply-contract summary exceeds its ${MAX_REPLY_SCHEMA_SUMMARY_BYTES}-byte cap (${bytes} bytes).`,
			{ path: "$", limit: "bytes", omittedCount: bytes - MAX_REPLY_SCHEMA_SUMMARY_BYTES },
		);
	}
	return summary;
}

type ReplySummaryContext = { root: Readonly<Record<string, unknown>>; nodes: number; refs: Set<string> };

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const JSON_SCHEMA_KEYS = new Set([
	"$schema", "$id", "$anchor", "$defs", "definitions", "$ref", "type", "enum", "const", "anyOf", "oneOf", "allOf", "not",
	"properties", "required", "additionalProperties", "propertyNames", "items", "prefixItems", "contains", "minContains", "maxContains",
	"minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum",
	"exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "default", "title", "description", "examples", "deprecated", "readOnly", "writeOnly",
]);

function summarizeReplySchema(value: unknown, path: string, depth: number, context: ReplySummaryContext): ReplySchemaSummary {
	if (depth > MAX_REPLY_SCHEMA_DEPTH) {
		throw new ReplyContractSummaryError(`Reply-contract depth exceeds ${MAX_REPLY_SCHEMA_DEPTH} at ${path}.`, { path, limit: "depth" });
	}
	context.nodes++;
	if (context.nodes > MAX_REPLY_SCHEMA_NODES) {
		throw new ReplyContractSummaryError(`Reply-contract node count exceeds ${MAX_REPLY_SCHEMA_NODES} at ${path}.`, { path, limit: "nodes", omittedCount: 1 });
	}
	if (value === true) return { types: ["any"] };
	if (value === false) throw summaryError("Reply contract contains an unsatisfiable false schema", path, "unsupported");
	if (!isRecord(value)) throw summaryError("Reply contract contains a malformed schema node", path, "unsupported");
	if (value.$ref !== undefined) {
		const { ref, target } = resolveReplyRef(value, path, context);
		// The ref stays open while its target is summarized so a self-referencing
		// chain is reported as recursion instead of exhausting the depth cap.
		context.refs.add(ref);
		try {
			return summarizeReplySchema(target, path, depth, context);
		} finally {
			context.refs.delete(ref);
		}
	}
	const schema = value;
	for (const key of Object.keys(schema)) {
		if (!JSON_SCHEMA_KEYS.has(key)) throw summaryError(`Unsupported validation keyword '${key}'`, path, "unsupported");
	}
	const types = replySchemaTypes(schema, path);
	const result: ReplySchemaSummary = {
		types,
		...(types.includes("null") ? { nullable: true as const } : {}),
	};

	if ("const" in schema) result.literalJson = exactJson(schema.const, `${path}/const`, MAX_REPLY_SCHEMA_STRING_CHARS);
	if (schema.enum !== undefined) {
		if (!Array.isArray(schema.enum)) throw summaryError("Schema enum must be an array", `${path}/enum`, "unsupported");
		if (schema.enum.length === 0) throw summaryError("An empty enum has no constructible value", `${path}/enum`, "unsupported");
		checkCollection(schema.enum, `${path}/enum`, "allowedValueJson");
		result.allowedValueJson = schema.enum.map((entry, index) => exactJson(entry, `${path}/enum/${index}`, MAX_REPLY_SCHEMA_STRING_CHARS));
	}
	if ("default" in schema) {
		result.hasDefault = true;
		result.defaultJson = exactJson(schema.default, `${path}/default`, MAX_REPLY_DEFAULT_BYTES, true);
	}

	const properties = schema.properties;
	if (properties !== undefined) {
		if (!isRecord(properties)) throw summaryError("Schema properties must be an object", `${path}/properties`, "unsupported");
		const entries = Object.entries(properties);
		checkCollection(entries, `${path}/properties`, "fields");
		const requiredValues = schema.required === undefined ? [] : schema.required;
		if (!Array.isArray(requiredValues) || requiredValues.some((entry) => typeof entry !== "string")) {
			throw summaryError("Schema required must be a string array", `${path}/required`, "unsupported");
		}
		checkCollection(requiredValues, `${path}/required`, "required");
		const names = new Set(entries.map(([name]) => name));
		for (const requiredName of requiredValues as string[]) {
			if (!names.has(requiredName)) throw summaryError(`Required property '${requiredName}' has no constructible property schema`, `${path}/required`, "unsupported");
		}
		const required = new Set(requiredValues as string[]);
		result.fields = entries.map(([name, field]) => {
			assertExactString(name, `${path}/properties/${name}`);
			const isRequired = required.has(name);
			return { name, required: isRequired, optional: !isRequired, value: summarizeReplySchema(field, `${path}/properties/${escapeSummaryPath(name)}`, depth + 1, context) };
		});
	}
	if (types.includes("object") || properties !== undefined || schema.additionalProperties !== undefined) {
		if (schema.additionalProperties === false) result.additionalProperties = "forbidden";
		else if (schema.additionalProperties === undefined || schema.additionalProperties === true) result.additionalProperties = "allowed";
		else {
			result.additionalProperties = "schema";
			result.additionalValue = summarizeReplySchema(schema.additionalProperties, `${path}/additionalProperties`, depth + 1, context);
		}
	}
	if (schema.propertyNames !== undefined) result.propertyNames = summarizeReplySchema(schema.propertyNames, `${path}/propertyNames`, depth + 1, context);
	if (schema.items !== undefined) result.element = summarizeReplySchema(schema.items, `${path}/items`, depth + 1, context);
	if (schema.prefixItems !== undefined) {
		if (!Array.isArray(schema.prefixItems)) throw summaryError("Schema prefixItems must be an array", `${path}/prefixItems`, "unsupported");
		checkCollection(schema.prefixItems, `${path}/prefixItems`, "tupleItems");
		result.tupleItems = schema.prefixItems.map((entry, index) => summarizeReplySchema(entry, `${path}/prefixItems/${index}`, depth + 1, context));
	}
	if (schema.contains !== undefined) result.contains = summarizeReplySchema(schema.contains, `${path}/contains`, depth + 1, context);

	for (const mode of ["anyOf", "oneOf", "allOf"] as const) {
		if (schema[mode] === undefined) continue;
		if (result.alternatives !== undefined) throw summaryError("Multiple alternative combinators on one schema node are not supported", path, "unsupported");
		const alternatives = schema[mode];
		if (!Array.isArray(alternatives)) throw summaryError(`Schema ${mode} must be an array`, `${path}/${mode}`, "unsupported");
		if (alternatives.length === 0 && mode !== "allOf") throw summaryError(`An empty ${mode} has no constructible value`, `${path}/${mode}`, "unsupported");
		checkCollection(alternatives, `${path}/${mode}`, "alternatives");
		result.alternativeMode = mode;
		result.alternatives = alternatives.map((entry, index) => summarizeReplySchema(entry, `${path}/${mode}/${index}`, depth + 1, context));
		if (types.length === 1 && types[0] === "any") {
			result.types = [...new Set(result.alternatives.flatMap((alternative) => alternative.types))];
		}
		if (result.alternatives.some((alternative) => alternative.nullable === true || alternative.types.includes("null"))) result.nullable = true;
	}
	if (schema.not !== undefined) result.not = summarizeReplySchema(schema.not, `${path}/not`, depth + 1, context);
	const constraints = replySchemaConstraints(schema, path);
	if (Object.keys(constraints).length > 0) result.constraints = constraints;
	return result;
}

/** Annotation and bookkeeping keywords that may legally sit next to `$ref` without validating anything. */
const REF_SIBLING_KEYS = new Set(["title", "description", "$schema", "$id", "$anchor", "$defs", "definitions"]);

function resolveReplyRef(schema: Record<string, unknown>, path: string, context: ReplySummaryContext): { ref: string; target: Record<string, unknown> } {
	if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) throw summaryError("Only local JSON Schema references are supported", `${path}/$ref`, "unsupported");
	if (Object.keys(schema).some((key) => key !== "$ref" && !REF_SIBLING_KEYS.has(key))) {
		throw summaryError("A referenced schema with sibling validation keywords is not supported", path, "unsupported");
	}
	const ref = schema.$ref;
	if (context.refs.has(ref)) throw summaryError(`Recursive schema reference '${ref}' cannot be represented within a finite gate contract`, `${path}/$ref`, "unsupported");
	let target: unknown = context.root;
	for (const rawSegment of ref.slice(2).split("/")) {
		const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isRecord(target) || !(segment in target)) throw summaryError(`Unresolved schema reference '${ref}'`, `${path}/$ref`, "unsupported");
		target = target[segment];
	}
	if (!isRecord(target)) throw summaryError(`Schema reference '${ref}' does not resolve to an object`, `${path}/$ref`, "unsupported");
	return { ref, target: { ...target } };
}

function replySchemaTypes(schema: Record<string, unknown>, path: string): string[] {
	const raw = schema.type;
	let types: string[];
	if (typeof raw === "string") types = [raw];
	else if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) types = [...new Set(raw as string[])];
	else if (raw !== undefined) throw summaryError("Schema type must be a string or string array", `${path}/type`, "unsupported");
	else if (schema.properties !== undefined || schema.additionalProperties !== undefined || schema.propertyNames !== undefined) types = ["object"];
	else if (schema.items !== undefined || schema.prefixItems !== undefined || schema.contains !== undefined) types = ["array"];
	else if ("const" in schema) types = [jsonValueType(schema.const)];
	else if (Array.isArray(schema.enum)) types = [...new Set(schema.enum.map(jsonValueType))];
	else types = ["any"];
	for (const type of types) {
		if (type === "any" && raw === undefined) continue;
		if (!JSON_SCHEMA_TYPES.has(type)) throw summaryError(`Unsupported JSON Schema type '${type}'`, `${path}/type`, "unsupported");
	}
	return types;
}

function replySchemaConstraints(schema: Record<string, unknown>, path: string): ReplySchemaConstraints {
	const constraints: ReplySchemaConstraints = {};
	for (const key of ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"] as const) {
		const value = schema[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value)) throw summaryError(`Schema ${key} must be a finite number`, `${path}/${key}`, "unsupported");
		constraints[key] = value;
	}
	for (const key of ["pattern", "format"] as const) {
		const value = schema[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw summaryError(`Schema ${key} must be a string`, `${path}/${key}`, "unsupported");
		assertExactString(value, `${path}/${key}`);
		constraints[key] = value;
	}
	if (schema.uniqueItems !== undefined) {
		if (schema.uniqueItems !== true && schema.uniqueItems !== false) throw summaryError("Schema uniqueItems must be boolean", `${path}/uniqueItems`, "unsupported");
		if (schema.uniqueItems) constraints.uniqueItems = true;
	}
	return constraints;
}

function checkCollection(values: readonly unknown[], path: string, collection: string): void {
	if (values.length <= MAX_REPLY_SCHEMA_COLLECTION_ITEMS) return;
	throw new ReplyContractSummaryError(
		`Reply-contract collection '${collection}' at ${path} exceeds ${MAX_REPLY_SCHEMA_COLLECTION_ITEMS} entries; ${values.length - MAX_REPLY_SCHEMA_COLLECTION_ITEMS} entries would be omitted.`,
		{ path, limit: "collection", collection, omittedCount: values.length - MAX_REPLY_SCHEMA_COLLECTION_ITEMS },
	);
}

function exactJson(value: unknown, path: string, cap: number, bytes = false): string {
	let json: string | undefined;
	try { json = JSON.stringify(value); } catch { throw summaryError("Schema value is not JSON serializable", path, "unsupported"); }
	if (json === undefined) throw summaryError("Schema value is not JSON serializable", path, "unsupported");
	const size = bytes ? payloadBytes(json) : json.length;
	if (size > cap) {
		throw new ReplyContractSummaryError(`Schema value at ${path} exceeds its ${cap}-${bytes ? "byte" : "character"} cap; ${size - cap} ${bytes ? "bytes" : "characters"} would be omitted.`, { path, limit: "string", omittedCount: size - cap });
	}
	return json;
}

function assertExactString(value: string, path: string): void {
	if (value.length > MAX_REPLY_SCHEMA_STRING_CHARS) {
		throw new ReplyContractSummaryError(`Schema string at ${path} exceeds ${MAX_REPLY_SCHEMA_STRING_CHARS} characters; ${value.length - MAX_REPLY_SCHEMA_STRING_CHARS} characters would be omitted.`, { path, limit: "string", omittedCount: value.length - MAX_REPLY_SCHEMA_STRING_CHARS });
	}
}

function jsonValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (isRecord(value)) return "object";
	return typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
}

function escapeSummaryPath(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function summaryError(message: string, path: string, limit: ReplyContractSummaryError["metadata"]["limit"]): ReplyContractSummaryError {
	return new ReplyContractSummaryError(`${message} at ${path}.`, { path, limit });
}

function displayString(value: string, max = PREVIEW_CHARS): DisplayStringSummary {
	const truncated = value.length > max;
	return {
		text: truncated ? `${value.slice(0, max - 1)}…` : value,
		originalChars: value.length,
		omittedChars: truncated ? value.length - (max - 1) : 0,
	};
}

function assertGateIdentity(value: string, path: string): void {
	if (value.length <= MAX_USER_GATE_IDENTITY_CHARS) return;
	throw new ReplyContractSummaryError(
		`Required gate identity at ${path} exceeds ${MAX_USER_GATE_IDENTITY_CHARS} characters; it cannot be truncated because respond requires the exact value.`,
		{ path, limit: "identity", omittedCount: value.length - MAX_USER_GATE_IDENTITY_CHARS },
	);
}

function checkGateCollection(values: readonly unknown[], path: string, collection: string): void {
	if (values.length <= MAX_USER_GATE_COLLECTION_ITEMS) return;
	throw new ReplyContractSummaryError(
		`Required gate collection '${collection}' at ${path} exceeds ${MAX_USER_GATE_COLLECTION_ITEMS} entries; dropping ${values.length - MAX_USER_GATE_COLLECTION_ITEMS} entries would make the interaction incomplete.`,
		{ path, limit: "collection", collection, omittedCount: values.length - MAX_USER_GATE_COLLECTION_ITEMS },
	);
}

function gateSummaryError(message: string, path: string, limit: ReplyContractSummaryError["metadata"]["limit"]): ReplyContractSummaryError {
	return new ReplyContractSummaryError(`${message} at ${path}.`, { path, limit });
}

export type ChartInspectStateSummary = {
	id: string;
	kind: HyperchartInspectState["kind"];
	initial?: boolean;
	agent?: string;
	role?: string;
	model?: string;
	resolvedModel?: string;
	thinking?: string;
	toolset?: string;
	tools?: readonly string[];
	omittedToolCount?: number;
	resolvedTools?: readonly string[];
	omittedResolvedToolCount?: number;
	agentDefinitionUnavailable?: boolean;
	description?: string;
	over?: string;
	concurrency?: number;
	regions?: string[];
	omittedRegionCount?: number;
	retries?: number;
	onReject?: HyperchartInspectState["onReject"];
	reads?: string[];
	omittedReadCount?: number;
	artifacts?: string[];
	omittedArtifactCount?: number;
	transitionDigests?: Array<{ event: string; target: string }>;
	omittedTransitionCount?: number;
};

export type ChartInspectSummary = {
	chartId: string;
	chartPath?: string;
	exportName?: string;
	mode: "static";
	stateCount: number;
	omittedStateCount?: number;
	unavailableAgents?: string[];
	omittedUnavailableAgentCount?: number;
	stateDigests: ChartInspectStateSummary[];
};

export function summarizeChartInspect(result: HyperchartInspectResult): ChartInspectSummary {
	const allUnavailable = [...new Set(result.states.filter((state) => state.agentDefinitionUnavailable === true && state.agent !== undefined).map((state) => state.agent as string))];
	const unavailableAgents = capStrings(allUnavailable);
	const stateDigests = result.states.slice(0, MAX_SUMMARY_STATES).map(summarizeInspectState);
	const summary: ChartInspectSummary = {
		chartId: truncate(result.chartId),
		...(result.chartPath === undefined ? {} : { chartPath: truncate(result.chartPath, 1000) }),
		...(result.exportName === undefined ? {} : { exportName: truncate(result.exportName) }),
		mode: result.mode,
		stateCount: result.states.length,
		...(result.states.length === stateDigests.length ? {} : { omittedStateCount: result.states.length - stateDigests.length }),
		...(unavailableAgents.length === 0 ? {} : { unavailableAgents }),
		...(allUnavailable.length === unavailableAgents.length ? {} : { omittedUnavailableAgentCount: allUnavailable.length - unavailableAgents.length }),
		stateDigests,
	};
	while (payloadBytes(JSON.stringify(summary)) > SUMMARY_TARGET_BYTES && summary.stateDigests.length > 0) {
		summary.stateDigests.pop();
		summary.omittedStateCount = result.states.length - summary.stateDigests.length;
	}
	return summary;
}

function summarizeInspectState(state: HyperchartInspectState): ChartInspectStateSummary {
	const tools = cappedStrings(state.tools);
	const resolvedTools = cappedStrings(state.resolvedTools);
	const regions = cappedStrings(state.regions);
	const reads = cappedStrings(state.reads, 1000);
	const artifacts = cappedArtifactPaths(state.artifacts, 1000);
	const transitions = state.transitions?.slice(0, MAX_NESTED_ITEMS).map((transition) => ({ event: truncate(transition.event), target: truncate(transition.target) }));
	return {
		id: truncate(state.id), kind: state.kind,
		...(state.initial === true ? { initial: true } : {}),
		...(state.agent === undefined ? {} : { agent: truncate(state.agent) }),
		...(state.role === undefined ? {} : { role: truncate(state.role) }),
		...(state.model === undefined ? {} : { model: truncate(state.model) }),
		...(state.resolvedModel === undefined ? {} : { resolvedModel: truncate(state.resolvedModel) }),
		...(state.thinking === undefined ? {} : { thinking: truncate(state.thinking) }),
		...(state.toolset === undefined ? {} : { toolset: truncate(state.toolset) }),
		...spreadCapped("tools", "omittedToolCount", tools),
		...spreadCapped("resolvedTools", "omittedResolvedToolCount", resolvedTools),
		...(state.agentDefinitionUnavailable === true ? { agentDefinitionUnavailable: true } : {}),
		...(state.description === undefined ? {} : { description: truncate(state.description) }),
		...(state.over === undefined ? {} : { over: truncate(state.over) }),
		...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		...spreadCapped("regions", "omittedRegionCount", regions),
		...(state.retries === undefined ? {} : { retries: state.retries }),
		...(state.onReject === undefined ? {} : { onReject: state.onReject }),
		...spreadCapped("reads", "omittedReadCount", reads),
		...spreadCapped("artifacts", "omittedArtifactCount", artifacts),
		...(transitions === undefined ? {} : {
			transitionDigests: transitions,
			...((state.transitions?.length ?? 0) === transitions.length ? {} : { omittedTransitionCount: (state.transitions?.length ?? 0) - transitions.length }),
		}),
	};
}

export type IssueSummary = { severity: string; kind: string; message: string; stateId?: string };
export type RunInspectStateSummary = {
	id: string; type?: HyperchartStateInfo["type"]; status: HyperchartStateInfo["status"]; agent?: string; role?: string; model?: string;
	resolvedModel?: string; toolset?: string; resolvedTools?: string[]; omittedResolvedToolCount?: number; completedEvent?: string;
	attempts?: number; validationAttempts?: number; visitCount?: number; mapKey?: string; subProgress?: HyperchartStateInfo["subProgress"];
	artifacts?: string[]; omittedArtifactCount?: number;
	sessionDigest?: { status: string; actionKey?: string; role?: string; model?: string; thinking?: string; toolset?: string; tools?: string[]; omittedToolCount?: number; turnCount?: number; toolCount?: number; tokenCount?: number; currentTool?: string; lastMessage?: string; error?: string };
	issues?: IssueSummary[]; omittedIssueCount?: number;
};
export type RunInspectSummary = {
	runId: string; chartName: string; mode?: HyperchartRunInfo["mode"]; status: HyperchartRunInfo["status"]; cwd: string;
	createdAt: number; updatedAt: number; pid?: number; stateCount: number; omittedStateCount?: number; finalOutputPreview?: string;
	totalUsage?: HyperchartRunInfo["totalUsage"]; issues?: IssueSummary[]; omittedIssueCount?: number; stateDigests: RunInspectStateSummary[];
	pendingStateIds?: string[]; omittedPendingStateCount?: number;
};

export function summarizeRunInspect(run: HyperchartRunInfo): RunInspectSummary {
	const stateDigests: RunInspectStateSummary[] = [];
	const pendingStateIds: string[] = [];
	let omittedActive = 0;
	let omittedPending = 0;
	for (const state of run.states) {
		if (state.status === "pending" && state.session === undefined && (state.issues?.length ?? 0) === 0) {
			if (pendingStateIds.length < MAX_SUMMARY_STATES) pendingStateIds.push(truncate(state.id)); else omittedPending++;
		} else if (stateDigests.length < MAX_SUMMARY_STATES) stateDigests.push(summarizeRunState(state)); else omittedActive++;
	}
	const issues = run.issues?.slice(0, MAX_NESTED_ITEMS).map(summarizeIssue);
	const summary: RunInspectSummary = {
		runId: truncate(run.runId), chartName: truncate(run.chartName), ...(run.mode === undefined ? {} : { mode: run.mode }), status: run.status,
		cwd: truncate(run.cwd, 1000), createdAt: run.createdAt, updatedAt: run.updatedAt, ...(run.pid === undefined ? {} : { pid: run.pid }),
		stateCount: run.stateCount, ...(omittedActive === 0 ? {} : { omittedStateCount: omittedActive }),
		...(run.finalOutput === undefined ? {} : { finalOutputPreview: truncate(run.finalOutput, 400) }),
		...(run.totalUsage === undefined ? {} : { totalUsage: run.totalUsage }),
		...(issues === undefined || issues.length === 0 ? {} : { issues, ...((run.issues?.length ?? 0) === issues.length ? {} : { omittedIssueCount: (run.issues?.length ?? 0) - issues.length }) }),
		stateDigests,
		...(pendingStateIds.length === 0 ? {} : { pendingStateIds }), ...(omittedPending === 0 ? {} : { omittedPendingStateCount: omittedPending }),
	};
	while (payloadBytes(JSON.stringify(summary)) > SUMMARY_TARGET_BYTES && (summary.pendingStateIds?.length ?? 0) > 0) { summary.pendingStateIds?.pop(); summary.omittedPendingStateCount = (summary.omittedPendingStateCount ?? 0) + 1; }
	while (payloadBytes(JSON.stringify(summary)) > SUMMARY_TARGET_BYTES && summary.stateDigests.length > 0) { summary.stateDigests.pop(); summary.omittedStateCount = (summary.omittedStateCount ?? 0) + 1; }
	return summary;
}

function summarizeRunState(state: HyperchartStateInfo): RunInspectStateSummary {
	const resolvedTools = cappedStrings(state.resolvedTools);
	const artifacts = cappedArtifactPaths(state.artifacts, 1000);
	const sessionTools = cappedStrings(state.session?.tools);
	const issues = state.issues?.slice(0, MAX_NESTED_ITEMS).map(summarizeIssue);
	return {
		id: truncate(state.id), ...(state.type === undefined ? {} : { type: state.type }), status: state.status,
		...(state.agent === undefined ? {} : { agent: truncate(state.agent) }), ...(state.role === undefined ? {} : { role: truncate(state.role) }),
		...(state.model === undefined ? {} : { model: truncate(state.model) }), ...(state.resolvedModel === undefined ? {} : { resolvedModel: truncate(state.resolvedModel) }),
		...(state.toolset === undefined ? {} : { toolset: truncate(state.toolset) }), ...spreadCapped("resolvedTools", "omittedResolvedToolCount", resolvedTools),
		...(state.completedEvent === undefined ? {} : { completedEvent: truncate(state.completedEvent) }), ...(state.attempts === undefined ? {} : { attempts: state.attempts }),
		...(state.validationAttempts === undefined ? {} : { validationAttempts: state.validationAttempts }), ...(state.visits === undefined ? {} : { visitCount: state.visits }),
		...(state.mapKey === undefined ? {} : { mapKey: truncate(state.mapKey) }), ...(state.subProgress === undefined ? {} : { subProgress: state.subProgress }),
		...spreadCapped("artifacts", "omittedArtifactCount", artifacts),
		...(state.session === undefined ? {} : { sessionDigest: {
			status: state.session.status, ...(state.session.actionKey === undefined ? {} : { actionKey: truncate(state.session.actionKey) }),
			...(state.session.role === undefined ? {} : { role: truncate(state.session.role) }), ...(state.session.model === undefined ? {} : { model: truncate(state.session.model) }),
			...(state.session.thinking === undefined ? {} : { thinking: truncate(state.session.thinking) }), ...(state.session.toolset === undefined ? {} : { toolset: truncate(state.session.toolset) }),
			...spreadCapped("tools", "omittedToolCount", sessionTools), ...(state.session.turnCount === undefined ? {} : { turnCount: state.session.turnCount }),
			...(state.session.toolCount === undefined ? {} : { toolCount: state.session.toolCount }), ...(state.session.tokenCount === undefined ? {} : { tokenCount: state.session.tokenCount }),
			...(state.session.currentTool === undefined ? {} : { currentTool: truncate(state.session.currentTool) }), ...(state.session.lastMessage === undefined ? {} : { lastMessage: truncate(state.session.lastMessage) }),
			...(state.session.error === undefined ? {} : { error: truncate(state.session.error) }),
		} }),
		...(issues === undefined || issues.length === 0 ? {} : { issues, ...((state.issues?.length ?? 0) === issues.length ? {} : { omittedIssueCount: (state.issues?.length ?? 0) - issues.length }) }),
	};
}

function summarizeIssue(issue: { severity: string; kind: string; message: string; stateId?: string }): IssueSummary {
	return { severity: truncate(issue.severity), kind: truncate(issue.kind), message: truncate(issue.message, 400), ...(issue.stateId === undefined ? {} : { stateId: truncate(issue.stateId) }) };
}
function truncate(value: string, max = PREVIEW_CHARS): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
function capStrings(values: readonly string[], maxChars = PREVIEW_CHARS): string[] { return values.slice(0, MAX_NESTED_ITEMS).map((value) => truncate(value, maxChars)); }
function cappedStrings(values: readonly string[] | undefined, maxChars = PREVIEW_CHARS): { values?: string[]; omitted: number } {
	if (values === undefined) return { omitted: 0 };
	return { values: capStrings(values, maxChars), omitted: Math.max(0, values.length - MAX_NESTED_ITEMS) };
}
function cappedArtifactPaths(values: readonly { path?: string }[] | undefined, maxChars: number): { values?: string[]; omitted: number } {
	if (values === undefined) return { omitted: 0 };
	const paths = values.flatMap((artifact) => artifact.path === undefined ? [] : [artifact.path]);
	const capped = capStrings(paths, maxChars);
	return { values: capped, omitted: values.length - capped.length };
}
function spreadCapped(valueKey: string, omittedKey: string, capped: { values?: string[]; omitted: number }): Record<string, unknown> {
	return capped.values === undefined ? {} : { [valueKey]: capped.values, ...(capped.omitted === 0 ? {} : { [omittedKey]: capped.omitted }) };
}
function payloadBytes(json: string): number { return new TextEncoder().encode(json).byteLength; }
function digestText(value: string): string {
	let hash = 0x811c9dc5;
	const bytes = new TextEncoder().encode(value);
	for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
