import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("HtmlPreview consumes create failures and renders an error placeholder", () => {
  assert.match(source, /createHtmlPreview\(content, filePath, sourceSessionId\)[\s\S]*?\.catch\(\(error\) => \{/);
  assert.match(
    source,
    /if \(!disposed\) setPreviewError\(error instanceof Error \? error\.message : String\(error\)\)/,
  );
  assert.match(source, /if \(previewError\) \{[\s\S]*?role="alert"[\s\S]*?HTML preview could not be created/);
});

test("HtmlPreview releases active and late URLs without leaking rejections", () => {
  assert.match(source, /if \(disposed\) \{\s*void window\.piBridge\.releaseHtmlPreview\(url\)\.catch\(\(\) => \{\}\)/);
  assert.match(
    source,
    /if \(activeUrl\) void window\.piBridge\.releaseHtmlPreview\(activeUrl\)\.catch\(\(\) => \{\}\)/,
  );
  assert.match(source, /setPreviewUrl\(null\);\s*setPreviewError\(null\)/);
});
