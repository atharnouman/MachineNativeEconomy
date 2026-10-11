// Writes docs/openapi.json from the gateway's route definitions. Run after `pnpm build`.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// import from the built package by path: this script lives outside any workspace package
const { buildOpenApi } = await import(new URL("../packages/gateway/dist/openapi.js", import.meta.url).href);
const doc = buildOpenApi({ url: "http://127.0.0.1:4402", version: "0.0.2" });
const dest = resolve(root, "docs/openapi.json");
writeFileSync(dest, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${dest} (${Object.keys(doc.paths).length} paths)`);
