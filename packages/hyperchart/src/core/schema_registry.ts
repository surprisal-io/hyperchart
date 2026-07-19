import type { ZodType } from "zod";
import type { RuntimeContractMetadata } from "./schema_contract.js";

function identityKey(contract: RuntimeContractMetadata): string {
	return JSON.stringify([contract.id, contract.version]);
}

/** In-memory sidecar for the exact schemas declared while one chart is parsed. */
export interface SchemaRegistryLike {
	get(contract: RuntimeContractMetadata): ZodType | undefined;
}

export class SchemaRegistry implements SchemaRegistryLike {
	readonly #schemas = new Map<string, { contract: RuntimeContractMetadata; schema: ZodType }>();

	register(contract: RuntimeContractMetadata, schema: ZodType): void {
		const key = identityKey(contract);
		const previous = this.#schemas.get(key);
		if (previous !== undefined && previous.schema !== schema) {
			throw new Error(
				`Conflicting runtime contract ${contract.id}@${contract.version}: the same id/version is used by different Zod schemas`,
			);
		}
		if (previous === undefined) this.#schemas.set(key, { contract, schema });
	}

	get(contract: RuntimeContractMetadata): ZodType | undefined {
		return this.#schemas.get(identityKey(contract))?.schema;
	}
}
