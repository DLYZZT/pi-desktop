import assert from "node:assert/strict";
import test from "node:test";
import { validatePiPackageGraph } from "../../scripts/pi-runtime-contract.mjs";

function fixture() {
  const packages = new Map();
  const files = new Set();
  const add = (name, dependencies = {}, prefix = "") => {
    const root = `${prefix}node_modules/@earendil-works/${name}`;
    const manifest = { name: `@earendil-works/${name}`, version: "0.85.0", main: "dist/index.js", dependencies };
    if (name === "pi-coding-agent") {
      manifest.bin = { pi: "dist/bundle/cli.js" };
      manifest.exports = {
        "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
        "./client": { import: "./dist/client/index.js" },
      };
      files.add(`${root}/dist/bundle/cli.js`);
      files.add(`${root}/dist/bundle/rpc-entry.js`);
      files.add(`${root}/dist/client/index.js`);
    }
    packages.set(`${root}/package.json`, manifest);
    files.add(`${root}/dist/index.js`);
    return root;
  };
  add("pi-ai");
  add("pi-telemetry");
  add("pi-coding-agent");
  return {
    packages,
    files,
    add,
    check: () =>
      validatePiPackageGraph({
        readPackage: (p) => packages.get(p),
        exists: (p) => packages.has(p) || files.has(p),
        version: "0.85.0",
      }),
  };
}

test("0.85 runtime graph detects the undeclared server edge and accepts nested dependency resolution", () => {
  const f = fixture();
  assert.throws(f.check, /missing: @earendil-works\/pi-server/);
  const server = f.add("pi-server", { "@earendil-works/chord": "^0.85.0" });
  assert.throws(f.check, /missing: @earendil-works\/chord/);
  const chord = f.add("chord", {}, `${server}/`);
  assert.equal(f.check().has(chord), true);
  f.packages.get(`${chord}/package.json`).version = "0.84.0";
  assert.throws(f.check, /version mismatch/);
});

test("runtime graph rejects metadata-only half packages and missing bundled entrypoints", () => {
  const f = fixture();
  const server = f.add("pi-server");
  f.files.delete(`${server}/dist/index.js`);
  assert.throws(f.check, /entry is missing/);
  f.files.add(`${server}/dist/index.js`);
  f.files.delete("node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js");
  assert.throws(f.check, /CLI\/RPC\/client/);
});
