import type { RenderedArtifact } from "../core/machine.js";
import type { SchemaRegistryLike } from "../core/schema_registry.js";
import { checkArtifactContent } from "../runtime/generic/artifacts.js";
import type { SchemaCheck } from "../runtime/generic/schema.js";

/** Execution-owned semantic validation over bytes acquired and snapshotted by runtime. */
export type ValidateArtifactSnapshot = (artifact: RenderedArtifact, content: string) => Promise<SchemaCheck>;

export function artifactSnapshotValidator(registry?: SchemaRegistryLike): ValidateArtifactSnapshot {
	return (artifact, content) => checkArtifactContent(artifact, content, registry);
}
