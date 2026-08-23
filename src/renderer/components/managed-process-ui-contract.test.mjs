import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("./ProcessPanel.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
const contract = await readFile(new URL("../../contract/processes.ts", import.meta.url), "utf8");

test("managed process UI pulls bounded plain-text logs from availability events", () => {
  assert.match(panel, /subscribe\("processes\.output"/);
  assert.match(panel, /call\("processes\.read"/);
  assert.match(panel, /slice\(-2_000\)/);
  assert.match(panel, /role="log"/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML\s*=/);
  const outputEvent = contract.slice(contract.indexOf("export interface ManagedProcessOutputEvent"));
  assert.doesNotMatch(outputEvent.split("}", 1)[0], /text|records|output:/);
});

test("managed process UI exposes lifecycle controls and independent Browser opening", () => {
  for (const method of ["stop", "restart", "dismiss", "export", "write"]) {
    assert.match(panel, new RegExp(`call\\(\\"processes\\.${method}\\"`));
  }
  assert.match(panel, /browserCreateUserTab/);
  assert.match(panel, /ownerSessionId: process\.ownerSessionId/);
  assert.match(shell, /PROCESSES_TAB_ID/);
  assert.match(shell, /activateUi/);
});

test("managed process setting defaults off and follows the Main capability projection", () => {
  assert.match(settings, /useState\(false\)/);
  assert.match(settings, /getManagedProcessCapability/);
  assert.match(settings, /managedProcessCapability\?\.ready/);
  assert.doesNotMatch(settings, /window\.piBridge\.platform === "win32"/);
  assert.match(settings, /managedProcessesEnabled/);
  assert.match(settings, /not a sandbox/);
});

test("containment failures are explicit and retain stop-all plus diagnostics actions", () => {
  assert.match(panel, /selected\.state === "lost"/);
  assert.match(panel, /call\("processes\.stopAll"/);
  assert.match(panel, /exportDiagnostics/);
  assert.match(panel, /role="alert"/);
});
