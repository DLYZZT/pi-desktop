import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../.artifacts/test-modules",
  `toolchains-config-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { ToolchainStateView } from "./ToolchainsConfig.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "toolchains-config-test-entry.tsx",
    loader: "tsx",
  },
  outfile: output,
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["react", "react-dom", "react-dom/*"],
  logLevel: "silent",
});

const { ToolchainStateView } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function capability(capability, overrides = {}) {
  return {
    capability,
    preference: "auto",
    health: "missing",
    candidates: [],
    ...overrides,
  };
}

test("renders verified providers, incomplete Node distributions, and the no-network promise", () => {
  const capabilities = {};
  for (const id of [
    "shell.bash",
    "shell.powershell",
    "vcs.git",
    "js.node",
    "js.npm",
    "js.npx",
    "js.bun",
    "python.interpreter",
    "python.uv",
    "python.uvx",
    "search.rg",
    "search.fd",
    "data.jq",
    "network.curl",
  ]) {
    capabilities[id] = capability(id);
  }
  capabilities["js.node"] = capability("js.node", {
    provider: "system",
    version: "22.19.0",
    pathLabel: "~/工具/node",
    health: "healthy",
    candidates: [
      {
        id: "node",
        capability: "js.node",
        provider: "system",
        version: "22.19.0",
        pathLabel: "~/工具/node",
        health: "healthy",
      },
    ],
  });
  capabilities["js.npm"] = capability("js.npm", {
    provider: "system",
    pathLabel: "~/工具/node",
    health: "incomplete",
    candidates: [],
  });
  const html = renderToStaticMarkup(
    createElement(ToolchainStateView, {
      state: {
        schemaVersion: 1,
        revision: 1,
        platform: "darwin",
        arch: "arm64",
        coreReady: true,
        capabilities,
        components: {
          "node-lts": {
            componentId: "node-lts",
            installed: false,
            availableVersion: "24.18.0",
            platformArch: "darwin-arm64",
            downloadBytes: 52_087_559,
            diskBytes: 0,
            sourceName: "Node.js",
            licenseName: "Node.js license",
            licenseUrl: "https://github.com/nodejs/node/blob/v24.18.0/LICENSE",
            health: "missing",
            canInstall: true,
            canRepair: false,
            canRemove: false,
          },
        },
        caches: {
          npm: { cacheId: "npm", diskBytes: 12_345_678, canClear: true },
          downloads: { cacheId: "downloads", diskBytes: 12_345_678, canClear: true },
        },
        operations: [
          {
            operationId: "op-1",
            componentId: "node-lts",
            phase: "downloading",
            downloadedBytes: 1_000_000,
            totalBytes: 2_000_000,
          },
        ],
        lastScanAt: "2026-07-17T12:00:00.000Z",
      },
      failed: false,
      rescanPending: false,
      onRescan() {},
      onAction() {},
    }),
  );

  assert.match(html, /Developer Tools/);
  assert.match(html, /Node\.js/);
  assert.match(html, /System/);
  assert.match(html, /v22\.19\.0/);
  assert.match(html, /Incomplete/);
  assert.match(html, /does not run shell profiles or access the network/);
  assert.match(html, /<button[^>]*>Rescan<\/button>/);
  assert.equal((html.match(/data-tool-id=/g) ?? []).length, 14);
  assert.match(html, /<aside[^>]*aria-label="Developer tool list"/);
  assert.match(html, /data-tool-id="js\.node"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /<details|<summary/);
  assert.match(html, /JavaScript/);
  assert.match(html, /Python/);
  assert.match(html, /CLI essentials/);
  assert.match(html, /Bash/);
  assert.match(html, /Git/);
  assert.match(html, /ripgrep \(rg\)/);
  assert.ok(html.indexOf("JavaScript") < html.indexOf("Python"));
  assert.ok(html.indexOf("Python") < html.indexOf("CLI essentials"));
  assert.match(html, /Tool resolution/);
  assert.match(html, /Detected providers/);
  assert.match(html, /Managed runtime/);
  assert.match(html, /Downloading/);
  assert.match(html, /<button[^>]*>Cancel<\/button>/);
  assert.match(html, /12 MB/);
  assert.match(html, /Node\.js preference/);
  assert.match(html, /does not modify the system PATH/);
  assert.doesNotMatch(html, /Essentials profiles|Managed components|Private caches/);
});
