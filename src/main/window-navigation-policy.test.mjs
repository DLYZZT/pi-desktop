import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedMainNavigation } from "./window-navigation-policy.ts";

test("main-window navigation requires an exact trusted origin", () => {
  assert.equal(isAllowedMainNavigation("app://bundle/index.html", false), true);
  assert.equal(isAllowedMainNavigation("app://preview/token/index.html", false), true);
  assert.equal(isAllowedMainNavigation("http://localhost:5173/settings", true), true);
  assert.equal(isAllowedMainNavigation("http://127.0.0.1:5173/settings", true), true);

  assert.equal(isAllowedMainNavigation("http://localhost:5173.evil.test/settings", true), false);
  assert.equal(isAllowedMainNavigation("http://127.0.0.1:5173.evil.test/settings", true), false);
  assert.equal(isAllowedMainNavigation("http://localhost:5174/settings", true), false);
  assert.equal(isAllowedMainNavigation("https://localhost:5173/settings", true), false);
  assert.equal(isAllowedMainNavigation("http://localhost:5173/settings", false), false);
  assert.equal(isAllowedMainNavigation("not a URL", true), false);
});
