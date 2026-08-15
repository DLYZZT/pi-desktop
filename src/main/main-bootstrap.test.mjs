import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("single-instance lock failure returns before Main registers lifecycle listeners", () => {
  const source = readFileSync(path.join(import.meta.dirname, "main.ts"), "utf8");
  const bootstrapStart = source.indexOf("function startMainProcess(): void {");
  const lockCheck = source.indexOf("!acquireSingleInstanceLock", bootstrapStart);
  const quit = source.indexOf("app.quit();", lockCheck);
  const earlyReturn = source.indexOf("return;", quit);
  const firstListener = source.indexOf('app.on("open-url"', lockCheck);
  const ready = source.indexOf("app.whenReady()", lockCheck);

  assert.ok(bootstrapStart >= 0);
  assert.ok(lockCheck > bootstrapStart);
  assert.ok(quit > lockCheck);
  assert.ok(earlyReturn > quit && earlyReturn < firstListener);
  assert.ok(firstListener > earlyReturn);
  assert.ok(ready > earlyReturn);
  assert.match(source, /}\r?\n\r?\nstartMainProcess\(\);\s*$/);
});
