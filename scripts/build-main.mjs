#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSuccessfulSpawn, resolvePackageFile } from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cleanMainBuildOutputs(projectRoot = root) {
  fs.rmSync(path.join(projectRoot, "out", "main"), { recursive: true, force: true });
  fs.rmSync(path.join(projectRoot, "out", "preload"), { recursive: true, force: true });
}

export function buildMain(projectRoot = root) {
  cleanMainBuildOutputs(projectRoot);
  const tsupCli = resolvePackageFile(projectRoot, "tsup", "dist/cli-default.js");
  assertSuccessfulSpawn(
    spawnSync(process.execPath, [tsupCli, "--config", "tsup.config.ts"], {
      cwd: projectRoot,
      stdio: "inherit",
    }),
    "main/preload/host build",
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    buildMain();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
