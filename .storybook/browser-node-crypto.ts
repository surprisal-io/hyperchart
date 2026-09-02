/** Browser-only Storybook seam for machine-generated runtime fixtures. */
export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
	return globalThis.crypto.randomUUID();
}
