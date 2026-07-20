// Copies the core package's built React stylesheet into this package's dist so
// the legacy `@surprisal/pi-hyperchart/react/styles.css` export keeps working.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const corePackage = require.resolve("@surprisal/hyperchart/package.json");
const source = join(dirname(corePackage), "dist/react/styles.css");
const target = resolve(process.cwd(), "dist/react/styles.css");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
