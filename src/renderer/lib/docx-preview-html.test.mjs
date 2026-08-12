import assert from "node:assert/strict";
import test from "node:test";

import { APP_MONO_FONT_FAMILY, APP_SANS_FONT_FAMILY } from "../../shared/font-stack.ts";
import { createDocxPreviewHtml } from "./docx-preview-html.ts";

test("DOCX previews inject readable light and dark theme tokens with shared fonts", () => {
  const content = '<p>正文 <a href="#">link</a><code>代码</code><img src="data:image/png;base64,x"/></p>';
  const light = createDocxPreviewHtml(content, "light");
  const dark = createDocxPreviewHtml(content, "dark");

  for (const [html, theme] of [
    [light, "light"],
    [dark, "dark"],
  ]) {
    assert.match(html, new RegExp(`name="color-scheme" content="${theme}"`));
    assert.ok(html.includes(`font-family:${APP_SANS_FONT_FAMILY}`));
    assert.ok(html.includes(`font-family:${APP_MONO_FONT_FAMILY}`));
    assert.match(html, /a\{color:var\(--link\)/);
    assert.match(html, /pre,code\{[^}]*background:var\(--code-bg\)/);
    assert.match(html, /img\{[^}]*max-width:100%/);
    assert.ok(html.endsWith(`${content}</body></html>`));
  }

  assert.match(light, /--bg:#fcfbf9;--text:#1c1a17/);
  assert.match(dark, /--bg:#1c1a17;--text:#faf9f7/);
  assert.notEqual(light, dark);
});
