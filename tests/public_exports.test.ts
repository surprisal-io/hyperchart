import { describe, expect, it } from "vitest";
import { refs } from "../src/index.js";

type PublicExports = keyof typeof import("../src/index.js");
type HasExport<Name extends string> = Name extends PublicExports ? true : false;

const unsafeExportsAreAbsent = {
	chart: false satisfies HasExport<"chart">,
	arg: false satisfies HasExport<"arg">,
	result: false satisfies HasExport<"result">,
	artifactOf: false satisfies HasExport<"artifactOf">,
	joinArtifactOf: false satisfies HasExport<"joinArtifactOf">,
	key: false satisfies HasExport<"key">,
	item: false satisfies HasExport<"item">,
};

describe("public authoring exports", () => {
	it("exposes typed refs as the chart entry point", () => {
		expect(typeof refs).toBe("function");
		expect(unsafeExportsAreAbsent).toEqual({
			chart: false,
			arg: false,
			result: false,
			artifactOf: false,
			joinArtifactOf: false,
			key: false,
			item: false,
		});
	});
});
