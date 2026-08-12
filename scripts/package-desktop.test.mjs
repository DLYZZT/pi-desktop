import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createDesktopPackageSteps, runDesktopPackageStep } from "./package-desktop.mjs";

test("pack and release plans use Node JS entries and set signing discovery in the child environment", () => {
  const projectRoot = path.resolve("C:/repo/pi-desktop");
  const nodeBinary = "C:/Program Files/nodejs/node.exe";
  const pack = createDesktopPackageSteps("--dir", { root: projectRoot, nodeBinary });
  const release = createDesktopPackageSteps("--release", { root: projectRoot, nodeBinary });

  for (const step of [...pack, ...release]) assert.equal(step.command, nodeBinary);
  assert.deepEqual(pack[2].args.slice(-1), ["--dir"]);
  assert.deepEqual(release[2].args.slice(-2), ["--publish", "never"]);
  assert.equal(pack[2].env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(release[2].env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(pack[1].args.includes("--release"), false);
  assert.equal(release[1].args.includes("--release"), true);
});

test("packaging rejects unknown modes and diagnoses spawn failures, signals, and missing statuses", () => {
  assert.throws(() => createDesktopPackageSteps("--unknown"), /--dir or --release/);
  const step = { label: "test", command: process.execPath, args: [] };
  assert.throws(
    () => runDesktopPackageStep(step, { spawnSync: () => ({ error: new Error("missing") }) }),
    /failed to start: missing/,
  );
  assert.throws(
    () => runDesktopPackageStep(step, { spawnSync: () => ({ signal: "SIGTERM", status: null }) }),
    /terminated by signal SIGTERM/,
  );
  assert.throws(
    () => runDesktopPackageStep(step, { spawnSync: () => ({ signal: null, status: null }) }),
    /no exit status/,
  );
  assert.throws(() => runDesktopPackageStep(step, { spawnSync: () => ({ signal: null, status: 7 }) }), /status 7/);
});
