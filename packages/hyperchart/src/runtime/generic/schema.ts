import { Value } from "typebox/value";
import { errorMessage } from "../../utils/errors.js";
import type { RuntimeContractMetadata } from "../../core/schema_contract.js";
import type { SchemaRegistryLike as SchemaRegistry } from "../../core/schema_registry.js";
import type { SchemaAst } from "../../core/types.js";

export type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

const MAX_ERRORS = 10;

/**
 * Backwards-compatible synchronous JSON Schema check. Explicit runtime contracts are checked
 * with the original Zod schema when a registry is supplied; async refinements fail closed here
 * and should use checkSchemaAsync.
 */
export function checkSchema(schema: SchemaAst, value: unknown, registry?: SchemaRegistry): SchemaCheck {
	if (schema.runtimeContract !== undefined) {
		return checkRuntimeSchemaSync(schema.runtimeContract, value, registry);
	}
	return checkJsonSchema(schema, value);
}

/** Exact validation for both sync and async runtime Zod contracts. */
export async function checkSchemaAsync(
	schema: SchemaAst,
	value: unknown,
	registry?: SchemaRegistry,
): Promise<SchemaCheck> {
	if (schema.runtimeContract !== undefined) {
		const original = registry?.get(schema.runtimeContract);
		if (original === undefined) return missingRuntimeContract(schema.runtimeContract);
		try {
			const result = await original.safeParseAsync(value);
			return result.success ? { ok: true } : zodIssues(result.error.issues);
		} catch (error) {
			return {
				ok: false,
				errors: [`runtime contract ${contractLabel(schema.runtimeContract)} validation failed: ${errorMessage(error)}`],
			};
		}
	}
	return checkJsonSchema(schema, value);
}

function checkRuntimeSchemaSync(
	contract: RuntimeContractMetadata,
	value: unknown,
	registry: SchemaRegistry | undefined,
): SchemaCheck {
	const original = registry?.get(contract);
	if (original === undefined) return missingRuntimeContract(contract);
	try {
		const result = original.safeParse(value);
		return result.success ? { ok: true } : zodIssues(result.error.issues);
	} catch (error) {
		return {
			ok: false,
			errors: [
				`runtime contract ${contractLabel(contract)} requires async validation: ${errorMessage(error)}`,
			],
		};
	}
}

function missingRuntimeContract(contract: RuntimeContractMetadata): SchemaCheck {
	return {
		ok: false,
		errors: [`runtime contract ${contractLabel(contract)} is unavailable; refusing JSON Schema fallback`],
	};
}

function checkJsonSchema(schema: SchemaAst, value: unknown): SchemaCheck {
	try {
		if (Value.Check(schema.schema, value)) return { ok: true };
		const errors = [...Value.Errors(schema.schema, value)]
			.slice(0, MAX_ERRORS)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`);
		return { ok: false, errors: errors.length === 0 ? ["value does not match schema"] : errors };
	} catch (error) {
		return {
			ok: false,
			errors: [`schema validation failed: ${errorMessage(error)}`],
		};
	}
}

function zodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): SchemaCheck {
	const errors = issues.slice(0, MAX_ERRORS).map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
	return { ok: false, errors: errors.length === 0 ? ["value does not match runtime contract"] : errors };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "/";
	return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function contractLabel(contract: RuntimeContractMetadata): string {
	return `${contract.id}@${contract.version}`;
}
