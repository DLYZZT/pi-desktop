import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const { projectExtensionDiagnostics } = await importTestBundle("src/agent-host/extension-diagnostics", {
  packages: "external",
  absWorkingDir: root,
  entryPoints: ["src/agent-host/extension-diagnostics.ts"],
});

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
