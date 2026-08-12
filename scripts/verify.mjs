#!/usr/bin/env node
/**
 * ISSUE-010: single quality gate that blocks pack/dist.
 * format → lint → typecheck → unit → contract → security → build → smoke
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, cmd, args) {
  console.log(`\n==> ${label}\n> ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n[verify] FAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
}

run("format check", "npm", ["run", "format:check"]);
run("lint", "npm", ["run", "lint"]);
run("typecheck (main/host)", "npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
run("typecheck (renderer)", "npx", ["tsc", "--noEmit", "-p", "tsconfig.renderer.json"]);
run("dependency contract", "node", ["scripts/check-dependency-contract.mjs"]);
run("unit tests", "npm", ["test"]);
run("contract coverage", "node", ["scripts/check-contract-coverage.mjs"]);
run("Pi 0.84 compatibility", "node", ["scripts/check-pi-084-compatibility.mjs"]);
run("toolchain contract safety", "node", ["scripts/check-toolchain-contract.mjs"]);
run("toolchain catalog", "node", [
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "scripts/verify-toolchain-catalog.mjs",
]);
run("Browser i18n invariants", "npm", ["run", "check:browser-i18n"]);
run("desktop security invariants", "node", ["scripts/check-desktop-security.mjs"]);
run("build", "npm", ["run", "build"]);
run("production artifact isolation", "node", ["scripts/check-production-artifacts.mjs"]);
run("smoke electron", "npm", ["run", "smoke"]);
run("Browser Electron integration", "npm", ["run", "test:browser-electron"]);
run("Browser real Agent E2E", "npm", ["run", "test:browser-agent-e2e"]);

console.log("\n[verify] all checks passed\n");
