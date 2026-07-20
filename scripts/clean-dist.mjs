import { rm } from "node:fs/promises";
import { resolve } from "node:path";

for (const directory of ["packages/hyperchart/dist", "packages/pi-hyperchart/dist", "packages/claude-hyperchart/dist"]) {
	await rm(resolve(import.meta.dirname, "..", directory), { recursive: true, force: true });
}
