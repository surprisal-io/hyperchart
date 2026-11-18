import { z } from "zod";

/** A revision of a declared artifact in this run's content-addressed store. */
export const ArtifactVersionSchema = z.object({
	path: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\:])[ -\uffff]+$/),
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	size: z.number().int().nonnegative(),
});

export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
