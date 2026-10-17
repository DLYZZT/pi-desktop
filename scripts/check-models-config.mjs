import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { preflightModelsConfig } from "../src/agent-host/models-config-validation.ts";

// Read-only: do not create a model runtime, credentials, caches, locks or migration backups.
try {
  const issues = preflightModelsConfig(process.argv[2] ?? path.join(getAgentDir(), "models.json"));
  console.log(JSON.stringify({ valid: issues.length === 0, issues }, null, 2));
  if (issues.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.code ?? "CONFIG_READ_FAILED" }));
  process.exitCode = 1;
}
