#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const entry = [join(here, "../src/mcp/server.ts"), join(here, "../dist/mcp/server.js")].find((p) => existsSync(p));
if (entry === undefined) throw new Error("hyperchart MCP server entry not found");
const mod = await jiti.import(entry);
await mod.main();
