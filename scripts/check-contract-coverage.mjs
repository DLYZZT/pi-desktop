#!/usr/bin/env node
/**
 * Assert every Api method has a host handler registration.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiTs = fs.readFileSync(path.join(root, "src/contract/api.ts"), "utf8");
const handlersTs = fs.readFileSync(path.join(root, "src/agent-host/handlers.ts"), "utf8");

// Extract only the Api interface body
const apiMatch = apiTs.match(/export interface Api \{([\s\S]*?)\n\}/);
if (!apiMatch) {
  console.error("Could not find Api interface");
  process.exit(1);
}
const methods = [...apiMatch[1].matchAll(/"([a-zA-Z0-9.]+)":\s*\{/g)].map((m) => m[1]);
const missing = methods.filter((m) => !handlersTs.includes(`"${m}"`) && !handlersTs.includes(`'${m}'`));

if (missing.length) {
  console.error("Missing host handlers for:", missing.join(", "));
  process.exit(1);
}
console.log(`OK: ${methods.length} Api methods have host handlers`);
