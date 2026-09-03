export type UUID = `${string}-${string}-${string}-${string}-${string}`;

type RandomSource = Pick<Crypto, "getRandomValues"> & {
	randomUUID?: () => UUID;
};

/** Generate a UUID in browsers where randomUUID is unavailable on insecure origins. */
export function randomUUID(source: RandomSource = globalThis.crypto): UUID {
	if (typeof source.randomUUID === "function") return source.randomUUID();

	const bytes = source.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
