import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const { projectExtensionDiagnostics, reconcileDiagnosticStatuses } = await importTestBundle(
  "src/agent-host/extension-diagnostics",
  {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/extension-diagnostics.ts"],
  },
);

test("Pi runtime extension diagnostics remain non-fatal and safe for the status UI", () => {
  const statuses = projectExtensionDiagnostics([
    {
      type: "error",
      message: 'Extension "/tmp/old-extension.ts" error:\nprovider API key=sk-supersecretvalue failed',
    },
    { type: "warning", message: "Legacy transform was ignored" },
  ]);

  assert.deepEqual(
    statuses.map((s) => s.text),
    ['Extension "/tmp/old-extension.ts" error: provider API key=[redacted] failed', "Legacy transform was ignored"],
  );
  assert.match(statuses[0].key, /^pi-runtime-error-/);
  assert.match(statuses[1].key, /^pi-runtime-warning-/);
  const diagnostic = { type: "warning", message: "Legacy transform was ignored" };
  assert.deepEqual(projectExtensionDiagnostics([diagnostic, diagnostic]), [statuses[1]]);
  assert.doesNotMatch(JSON.stringify(statuses), /supersecret/);
});

test("saved picker entries outside the available catalog do not become session warnings", () => {
  const patterns = Object.freeze([
    "github-copilot/claude-fable-5",
    "google/gemini-3.1-flash-live-preview",
    "nvidia/meta/llama-3.2-90b-vision-instruct",
    "shared-model",
  ]);
  let available = [];
  const session = {
    settingsManager: { getEnabledModels: () => patterns },
    modelRuntime: { getAvailableSnapshot: () => available },
  };
  const events = [];
  const reconcile = (previous) => reconcileDiagnosticStatuses(session, [], previous, (event) => events.push(event));
  let statuses = reconcile(new Map());
  assert.equal(statuses.size, 0);
  assert.deepEqual(events, []);

  available = [{ provider: "first", id: "shared-model", name: "Shared model" }];
  statuses = reconcile(statuses);
  assert.equal(statuses.size, 0);
  assert.deepEqual(events, []);

  available.push({ provider: "second", id: "shared-model", name: "Shared model" });
  statuses = reconcile(statuses);
  assert.equal(events.length, 1);
  assert.match(events[0].statusText, /matches several providers: first, second/);
  reconcile(statuses);
  assert.equal(events.length, 1);
});
