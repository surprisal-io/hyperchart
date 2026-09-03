import { describe, expect, it } from "vitest";
import { randomUUID } from "../packages/hyperchart/src/utils/random_uuid.js";

describe("randomUUID", () => {
	it("uses the platform implementation when available", () => {
		const uuid = "11111111-2222-4333-8444-555555555555" as const;
		expect(randomUUID({ randomUUID: () => uuid, getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })).toBe(uuid);
	});

	it("builds an RFC 4122 version 4 UUID from random bytes when randomUUID is unavailable", () => {
		const uuid = randomUUID({
			getRandomValues(array) {
				const bytes = array as unknown as Uint8Array;
				for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
				return array;
			},
		});

		expect(uuid).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
	});
});
