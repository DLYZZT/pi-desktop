import assert from "node:assert/strict";
import test from "node:test";

import { layoutCockpitBounds } from "./cockpit-windows.ts";

test("cockpit windows sit on the left and right edges and leave the middle empty", () => {
  const layout = layoutCockpitBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(layout.left.x, 0);
  assert.equal(layout.right.x + layout.right.width, 1920);
  assert.ok(layout.left.width + layout.right.width < 1920);
  assert.ok(layout.left.x + layout.left.width <= layout.right.x);
});
