#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createDesktopPackageSteps(mode, options = {}) {
  if (mode !== "--dir" && mode !== "--release") {
    throw new Error(`expected exactly one packaging mode: --dir or --release (received ${mode ?? "none"})`);
  }
  const projectRoot = options.root ?? root;
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const release = mode === "--release";
  return [
    {
      label: "verify",
      command: nodeBinary,
      args: [path.join(projectRoot, "scripts", "verify.mjs")],
    },
    {
      label: "prepare bundled tools",
      command: nodeBinary,
      args: [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        path.join(projectRoot, "scripts", "prepare-bundled-tools.mjs"),
        ...(release ? ["--release"] : []),
      ],
    },
    {
      label: "electron-builder",
      command: nodeBinary,
      args: [
        path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
        ...(release ? ["--publish", "never"] : ["--dir"]),
      ],
      env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  ];
}

export function runDesktopPackageStep(step, options = {}) {
  console.log(`> ${step.command} ${step.args.join(" ")}`);
  const result = (options.spawnSync ?? spawnSync)(step.command, step.args, {
    cwd: options.root ?? root,
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  if (result.error) throw new Error(`[package] ${step.label} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`[package] ${step.label} terminated by signal ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error(`[package] ${step.label} returned no exit status`);
  if (result.status !== 0) throw new Error(`[package] ${step.label} exited with status ${result.status}`);
}

export function runDesktopPackage(mode, options = {}) {
  for (const step of createDesktopPackageSteps(mode, options)) runDesktopPackageStep(step, options);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error("expected exactly one packaging mode: --dir or --release");
    runDesktopPackage(args[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
