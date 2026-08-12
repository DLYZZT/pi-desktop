import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { SyntaxHighlighter, preloadSyntaxHighlighter } = await importTestBundle("src/renderer/lib/syntax-highlight", {
  entryPoints: [path.join(import.meta.dirname, "syntax-highlight.ts")],
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
});
await preloadSyntaxHighlighter();

function render(language, code) {
  return renderToStaticMarkup(createElement(SyntaxHighlighter, { language }, code));
}

test("custom aliases and common grammars go through the real highlighter", () => {
  const samples = {
    zsh: "if true; then echo ok; fi",
    "c++": "int main() { return 0; }",
    less: "@color: red; .item { color: @color; }",
    patch: "+added line",
    golang: "func main() { return }",
    jsonl: '{"ok": true}',
    rs: "fn main() { let ok = true; }",
  };

  for (const [language, code] of Object.entries(samples)) {
    assert.match(render(language, code), /class="token /, `${language} should produce highlighted tokens`);
  }
});

test("languages outside the startup set remain available after the async load", () => {
  const samples = {
    powershell: 'Write-Host "hello"',
    lua: "local ok = true",
    r: "square <- function(x) x * x",
    dart: 'void main() { print("hello"); }',
  };

  for (const [language, code] of Object.entries(samples)) {
    assert.match(render(language, code), /class="token /, `${language} should produce highlighted tokens`);
  }
});

test("plain text and unknown ids fall back without highlighting", () => {
  assert.doesNotMatch(render("text", "plain words"), /class="token /);
  assert.doesNotMatch(render("plaintext", "plain words"), /class="token /);
  assert.doesNotMatch(render("definitely-not-a-language", "plain words"), /class="token /);
});
