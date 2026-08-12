import assert from "node:assert/strict";
import test from "node:test";

import { APP_MONO_FONT_FAMILY, APP_SANS_FONT_FAMILY } from "../shared/font-stack.ts";
import { createLoadFailurePage, createRendererCrashPage, RENDERER_CRASH_RETRY_URL } from "./window-load-failure.ts";

test("load failure page escapes diagnostics and blocks active content", () => {
  const page = createLoadFailurePage(-7, '<img src=x onerror="alert(1)">', "app://bundle/<script>x</script>");

  assert.doesNotMatch(page, /<script>|<img/);
  assert.match(page, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, /base-uri 'none'/);
  assert.match(page, /form-action 'none'/);
});

test("renderer crash page is inert, escaped, and exposes only the exact retry link", () => {
  const page = createRendererCrashPage('<img src=x onerror="alert(1)">');

  assert.doesNotMatch(page, /<script>|<img/);
  assert.match(page, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, new RegExp(RENDERER_CRASH_RETRY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("failure pages use shared CJK fonts and native light or dark colors", () => {
  const light = createLoadFailurePage(-1, "failed", "app://bundle", "light");
  const dark = createRendererCrashPage("oom", "dark");

  for (const page of [light, dark]) {
    assert.ok(page.includes(`font-family:${APP_SANS_FONT_FAMILY}`));
    assert.ok(page.includes(`font-family:${APP_MONO_FONT_FAMILY}`));
  }
  assert.match(light, /name="color-scheme" content="light"/);
  assert.match(light, /--bg:#f7f6f3/);
  assert.match(light, /--text:#1c1a17/);
  assert.match(dark, /name="color-scheme" content="dark"/);
  assert.match(dark, /--bg:#141210/);
  assert.match(dark, /--text:#faf9f7/);
});
