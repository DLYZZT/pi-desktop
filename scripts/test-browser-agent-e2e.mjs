#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  createProjectBuildTemp,
  projectNodePath,
  resolveElectronBinary,
  terminateProcessTree,
} from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = createProjectBuildTemp(root, "pi-browser-agent-e2e-build-");
const hostOutfile = path.join(temp, "browser-agent-host.mjs");
const mainOutfile = path.join(temp, "browser-agent-e2e-harness.cjs");

function build(entry, outfile, format, externals) {
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    packages: "external",
    format,
    external: externals,
    outfile,
    logLevel: "info",
  });
}

try {
  build("src/smoke/browser-agent-host.ts", hostOutfile, "esm", [
    "electron",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "silk-wasm",
  ]);
  build("src/smoke/browser-agent-e2e-harness.ts", mainOutfile, "cjs", ["electron"]);

  const electronBinary = resolveElectronBinary(root);
  const child = spawn(electronBinary, [mainOutfile], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: projectNodePath(root, process.env.NODE_PATH),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PI_BROWSER_AGENT_E2E_HOST_ENTRY: hostOutfile,
    },
    detached: process.platform !== "win32",
  });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("Browser Agent E2E harness timed out");
      terminateProcessTree(child);
      resolve(1);
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) console.error(`Browser Agent E2E harness terminated by signal ${signal}`);
      resolve(code ?? 1);
    });
  });
  process.exitCode = status;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
