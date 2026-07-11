#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./hyperchart_runner.ts");
await mod.main(process.argv.slice(2));
