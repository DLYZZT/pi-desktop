import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_RUNTIME_ROOTS,
  validatePiPackageGraph,
  validatePiRuntimeAssets,
} from "../../scripts/pi-runtime-contract.mjs";

function fixture(version = "0.85.0") {
  const packages = new Map();
  const files = new Set();
  const add = (name, dependencies = {}, prefix = "") => {
    const root = `${prefix}node_modules/@earendil-works/${name}`;
    const manifest = { name: `@earendil-works/${name}`, version, main: "dist/index.js", dependencies };
    if (name === "pi-coding-agent") {
      manifest.bin = { pi: "dist/bundle/cli.js" };
      manifest.exports = {
        "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
        "./client": version === "0.85.0" ? { import: "./dist/client/index.js" } : { source: "./src/client/index.ts" },
      };
      files.add(`${root}/dist/bundle/cli.js`);
      files.add(`${root}/dist/bundle/rpc-entry.js`);
      if (version === "0.85.0") files.add(`${root}/dist/client/index.js`);
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
        version,
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
  assert.throws(f.check, /CLI\/RPC/);
});

test("0.87.1 graph accepts source-only client and still requires published CLI/RPC entries", () => {
  const f = fixture("0.87.1");
  const codingRoot = "node_modules/@earendil-works/pi-coding-agent";
  const coding = f.packages.get(`${codingRoot}/package.json`);
  coding.dependencies = { "@earendil-works/pi-agent-core": "^0.87.1" };
  const agentRoot = f.add("pi-agent-core", { "@earendil-works/chord": "^0.87.1" }, `${codingRoot}/`);
  f.add("chord", {}, `${agentRoot}/`);
  assert.equal(f.check().has(agentRoot), true);
  f.files.delete(`${codingRoot}/dist/bundle/rpc-entry.js`);
  assert.throws(f.check, /CLI\/RPC entry is missing/);
});

for (const layout of ["hoisted", "nested"]) {
  test(`0.99.1 ${layout} graph rejects missing, mismatched and metadata-only MCP/codemode packages`, () => {
    const f = fixture("0.99.1");
    const codingRoot = "node_modules/@earendil-works/pi-coding-agent";
    f.packages.get(`${codingRoot}/package.json`).dependencies = {
      "@earendil-works/pi-codemode": "^0.99.1",
      "@earendil-works/pi-mcp": "^0.99.1",
    };
    const check = () =>
      validatePiPackageGraph({
        readPackage: (p) => f.packages.get(p),
        exists: (p) => f.packages.has(p) || f.files.has(p),
        version: "0.99.1",
        rootPackages: PI_RUNTIME_ROOTS,
      });
    assert.throws(check, /missing: @earendil-works\/pi-codemode/);
    const codemode = f.add("pi-codemode", {}, layout === "nested" ? `${codingRoot}/` : "");
    assert.throws(check, /missing: @earendil-works\/pi-mcp/);
    const mcp = f.add("pi-mcp");
    if (layout === "nested") f.add("pi-mcp", {}, `${codingRoot}/`);
    assert.ok(check().has(codemode));
    assert.ok(check().has(mcp));
    f.packages.get(`${codemode}/package.json`).version = "0.87.1";
    assert.throws(check, /version mismatch/);
    f.packages.get(`${codemode}/package.json`).version = "0.99.1";
    f.files.delete(`${codemode}/dist/index.js`);
    assert.throws(check, /entry is missing/);
    f.files.add(`${codemode}/dist/index.js`);
    f.packages.get(`${mcp}/package.json`).version = "0.87.1";
    assert.throws(check, /version mismatch/);
    f.packages.get(`${mcp}/package.json`).version = "0.99.1";
    f.files.delete(`${mcp}/dist/index.js`);
    assert.throws(check, /entry is missing/);
  });
}

test("0.99.1 asset validation resolves WASM through the importing package and rejects missing lazy modules", () => {
  const f = fixture("0.99.1");
  const codemode = f.add("pi-codemode", {}, "node_modules/@earendil-works/pi-coding-agent/");
  const mcp = f.add("pi-mcp");
  const wasmRoot = "node_modules/@earendil-works/pi-coding-agent/node_modules/quickjs-wasi";
  f.packages.set(`${wasmRoot}/package.json`, { name: "quickjs-wasi", version: "3.6.2" });
  const required = [
    "node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js",
    `${codemode}/dist/runtime/worker.js`,
    `${mcp}/dist/oauth/index.js`,
    `${wasmRoot}/quickjs.wasm`,
  ];
  for (const entry of required) f.files.add(entry);
  const check = () =>
    validatePiRuntimeAssets({
      graph: new Map([
        ["node_modules/@earendil-works/pi-ai", "0.99.1"],
        [codemode, "0.99.1"],
        [mcp, "0.99.1"],
      ]),
      readPackage: (p) => f.packages.get(p),
      exists: (p) => f.packages.has(p) || f.files.has(p),
    });
  assert.equal(check().size, required.length);
  for (const entry of required) {
    f.files.delete(entry);
    assert.throws(check, /runtime asset is missing/);
    f.files.add(entry);
  }
  f.packages.get(`${wasmRoot}/package.json`).version = "3.5.0";
  assert.throws(check, /QuickJS WASI version mismatch/);
});
