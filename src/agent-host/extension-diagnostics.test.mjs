import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const outputDirectory = path.join(root, ".artifacts", "test-modules");
mkdirSync(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, `extension-diagnostics-${process.pid}.mjs`);
await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/extension-diagnostics.ts"],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  sourcemap: false,
  logLevel: "silent",
});
const { projectExtensionDiagnostics } = await import(`${pathToFileURL(outputFile).href}?v=${Date.now()}`);

test("Pi runtime extension diagnostics remain non-fatal and safe for the status UI", () => {
  const statuses = projectExtensionDiagnostics([
    {
      type: "error",
      message: 'Extension "/tmp/old-extension.ts" error:\nprovider API key=sk-supersecretvalue failed',
    },
    { type: "warning", message: "Legacy transform was ignored" },
  ]);

  assert.deepEqual(statuses, [
    {
      key: "pi-runtime-error-1",
      text: 'Extension "/tmp/old-extension.ts" error: provider API key=[redacted] failed',
    },
    { key: "pi-runtime-warning-2", text: "Legacy transform was ignored" },
  ]);
  assert.doesNotMatch(JSON.stringify(statuses), /supersecret/);
});
