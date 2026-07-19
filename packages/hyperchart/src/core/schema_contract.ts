import { z, type ZodType } from "zod";

export type RuntimeContractMetadata = Readonly<{
	id: string;
	version: string;
}>;

// The global symbol only coordinates package copies loaded by Jiti; the schema itself carries
// the metadata, so no process-global schema registry is retained.
const RUNTIME_CONTRACT = Symbol.for("@surprisal/hyperchart.runtimeContract");
type ContractedSchema = object & { readonly [RUNTIME_CONTRACT]?: RuntimeContractMetadata };

/**
 * Declares that a Zod schema is an exact runtime contract.
 *
 * The schema value itself is returned unchanged, so `z.infer<typeof Schema>` remains
 * ergonomic. Metadata is kept in a non-enumerable symbol property; normalization copies only
 * the stable id/version into the serializable AST and keeps the original schema in a per-chart
 * registry.
 */
export function contract<S extends ZodType>(id: string, version: string, schema: S): S {
	if (typeof id !== "string" || id.length === 0) throw new TypeError("contract id must be a non-empty string");
	if (typeof version !== "string" || version.length === 0) {
		throw new TypeError("contract version must be a non-empty string");
	}
	if (!(schema instanceof z.ZodType)) {
		throw new TypeError("contract schema must be a Zod schema value");
	}
	const contracted = schema as S & ContractedSchema;
	const previous = contracted[RUNTIME_CONTRACT];
	if (previous !== undefined && (previous.id !== id || previous.version !== version)) {
		throw new Error(
			`Zod schema is already declared as runtime contract ${previous.id}@${previous.version}; cannot redeclare as ${id}@${version}`,
		);
	}
	if (previous === undefined) {
		Object.defineProperty(contracted, RUNTIME_CONTRACT, {
			value: Object.freeze({ id, version }),
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}
	return schema;
}

export function runtimeContractMetadata(value: unknown): RuntimeContractMetadata | undefined {
	return typeof value === "object" && value !== null
		? (value as ContractedSchema)[RUNTIME_CONTRACT]
		: undefined;
}
