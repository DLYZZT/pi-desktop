import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `form-controls-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { Check, Field, NumInput, SecretTextInput, Select, TextInput } from "./form-controls.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "form-controls-test-entry.tsx",
    loader: "tsx",
  },
  outfile: output,
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["react", "react-dom", "react-dom/*"],
  logLevel: "silent",
});

const { Check, Field, NumInput, SecretTextInput, Select, TextInput } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

function assertFieldAssociation(Control, props, tagName) {
  const html = renderToStaticMarkup(createElement(Field, { label: "Accessible field" }, createElement(Control, props)));
  const labelMatch = html.match(/<label[^>]*for="([^"]+)"/);
  assert.ok(labelMatch, html);
  const controlId = labelMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`<${tagName}[^>]*id="${controlId}"`));
  assert.match(html, /min-height:36px/);
  assert.match(html, /font-size:13px/);
}

test("Field associates its label with every shared input type", () => {
  assertFieldAssociation(TextInput, { value: "name", onChange() {} }, "input");
  assertFieldAssociation(SecretTextInput, { value: "secret", onChange() {} }, "input");
  assertFieldAssociation(NumInput, { value: "42", onChange() {} }, "input");
  assertFieldAssociation(Select, { value: "one", onChange() {}, options: ["one"] }, "select");
});

test("compact shared controls expose at least a 32px pointer target", () => {
  const secretHtml = renderToStaticMarkup(
    createElement(Field, { label: "API key" }, createElement(SecretTextInput, { value: "secret", onChange() {} })),
  );
  assert.match(secretHtml, /aria-label="Show API key"/);
  assert.match(secretHtml, /width:32px;height:32px/);

  const checkHtml = renderToStaticMarkup(createElement(Check, { label: "Reasoning", checked: true, onChange() {} }));
  assert.match(checkHtml, /min-height:36px/);
  assert.match(checkHtml, /width:18px;height:18px/);
  assert.match(checkHtml, /font-size:13px/);
});
