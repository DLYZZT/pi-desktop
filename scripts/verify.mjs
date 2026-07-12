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
run("unit tests", "npm", ["test"]);
run("contract coverage", "node", ["scripts/check-contract-coverage.mjs"]);
run("desktop security invariants", "node", ["scripts/check-desktop-security.mjs"]);
run("build", "npm", ["run", "build"]);
run("production artifact isolation", "node", ["scripts/check-production-artifacts.mjs"]);
run("smoke electron", "npm", ["run", "smoke"]);

console.log("\n[verify] all checks passed\n");
