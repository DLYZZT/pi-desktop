import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launcherSource = readFileSync(new URL("./smoke-electron.mjs", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/smoke/main.ts", import.meta.url), "utf8");

test("Electron smoke uses and removes an isolated userData directory", () => {
  assert.match(launcherSource, /mkdtempSync\(path\.join\(tmpdir\(\), "pi-desktop-smoke-"\)\)/);
  assert.match(launcherSource, /PI_DESKTOP_SMOKE_USER_DATA:\s*smokeUserData/);
  assert.match(launcherSource, /rmSync\(smokeUserData, \{ recursive: true, force: true \}\)/);
  assert.match(mainSource, /app\.setPath\("userData", smokeUserData\)/);
  assert.ok(
    mainSource.indexOf('app.setPath("userData", smokeUserData)') < mainSource.indexOf("app.whenReady()"),
    "smoke userData must be set before Electron becomes ready",
  );
});
