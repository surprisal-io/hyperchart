import { Value } from "typebox/value";
import type { SchemaAst } from "../../core/types.js";

export type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

const MAX_ERRORS = 10;

export function checkSchema(schema: SchemaAst, value: unknown): SchemaCheck {
	try {
		if (Value.Check(schema.schema, value)) {
			return { ok: true };
		}
		const errors = [...Value.Errors(schema.schema, value)]
			.slice(0, MAX_ERRORS)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`);
		return { ok: false, errors: errors.length === 0 ? ["value does not match schema"] : errors };
	} catch (error) {
		return {
			ok: false,
			errors: [`schema validation failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}
