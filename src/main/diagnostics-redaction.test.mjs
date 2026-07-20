import assert from "node:assert/strict";
import test from "node:test";
import { buildToolchainDiagnosticSummary, redactDiagnosticText } from "./diagnostics-redaction.ts";

test("redacts private roots, auth headers, registry tokens, JSON secrets, and proxy credentials", () => {
  const input = [
    "/Users/李/Library/Application Support/Pi/toolchains/state.json",
    "/Users/李/Library/Logs/Pi/main.log",
    "/Users/李/project/package.json",
    "Authorization: Bearer should-not-leak",
    "NODE_AUTH_TOKEN=npm_abcdefghijklmnopqrstuvwxyz",
    '"apiKey":"sk-private-value"',
    "https://proxy-user:proxy-password@proxy.example.test/path",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
  ].join("\n");
  const redacted = redactDiagnosticText(input, {
    homeDir: "/Users/李",
    userDataDir: "/Users/李/Library/Application Support/Pi",
    logsDir: "/Users/李/Library/Logs/Pi",
    platform: "darwin",
  });
  assert.match(redacted, /<userData>\/toolchains\/state\.json/);
  assert.match(redacted, /<logs>\/main\.log/);
  assert.match(redacted, /\$HOME\/project\/package\.json/);
  for (const secret of [
    "should-not-leak",
    "npm_abcdefghijklmnopqrstuvwxyz",
    "sk-private-value",
    "proxy-user",
    "proxy-password",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
  ]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
});

test("toolchain diagnostic summaries contain health and revisions but no candidate paths or raw errors", () => {
  const summary = buildToolchainDiagnosticSummary({
    schemaVersion: 1,
    revision: 12,
    platform: "darwin",
    arch: "arm64",
    coreReady: true,
    capabilities: {
      "js.node": {
        capability: "js.node",
        preference: "auto",
        provider: "system",
        version: "24.18.0",
        pathLabel: "~/secret/node",
        health: "healthy",
        candidates: [
          {
            id: "private-id",
            capability: "js.node",
            provider: "system",
            pathLabel: "~/secret/node",
            health: "healthy",
          },
        ],
      },
    },
    components: {},
    caches: { npm: { cacheId: "npm", diskBytes: 42, canClear: true } },
    operations: [
      {
        operationId: "private-operation-id",
        componentId: "node-lts",
        phase: "error",
        error: { code: "TOOLCHAIN_DOWNLOAD_OFFLINE", message: "token=secret" },
      },
    ],
    lastScanAt: "2026-07-17T00:00:00.000Z",
  });
  const serialized = JSON.stringify(summary);
  assert.equal(summary.revision, 12);
  assert.equal(summary.platformArch, "darwin-arm64");
  assert.match(serialized, /TOOLCHAIN_DOWNLOAD_OFFLINE/);
  for (const privateValue of ["~/secret/node", "private-id", "private-operation-id", "token=secret"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});
