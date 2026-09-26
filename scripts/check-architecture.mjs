#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture } from "./architecture-checker.mjs";
import { architecturePolicy } from "./architecture-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = checkArchitecture({ root, policy: architecturePolicy });
if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else if (result.failures.length) {
  console.error("[architecture] " + result.failures.length + " invariant(s) failed");
  for (const failure of result.failures) console.error("- " + failure);
} else {
  console.log(
    "Architecture OK: " +
      result.stats.modules +
      " modules, " +
      result.stats.runtimeEdges +
      " runtime dependencies; " +
      result.stats.codeBudgets +
      " fixed code ceilings and " +
      result.stats.dataModules.length +
      " checked data module(s)",
  );
}
if (result.failures.length) process.exitCode = 1;
