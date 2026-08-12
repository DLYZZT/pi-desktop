import assert from "node:assert/strict";
import test from "node:test";
import { developerViewRoles } from "./menu-policy.ts";

test("reload and DevTools roles are exposed only in development menus", () => {
  assert.deepEqual(developerViewRoles(false), []);
  assert.deepEqual(developerViewRoles(true), ["reload", "forceReload", "toggleDevTools"]);
});
