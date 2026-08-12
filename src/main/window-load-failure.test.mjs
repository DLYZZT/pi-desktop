import assert from "node:assert/strict";
import test from "node:test";

import { createLoadFailurePage } from "./window-load-failure.ts";

test("load failure page escapes diagnostics and blocks active content", () => {
  const page = createLoadFailurePage(-7, '<img src=x onerror="alert(1)">', "app://bundle/<script>x</script>");

  assert.doesNotMatch(page, /<script>|<img/);
  assert.match(page, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, /base-uri 'none'/);
  assert.match(page, /form-action 'none'/);
});
