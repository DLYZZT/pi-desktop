import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../.artifacts/test-modules", `main-protocol-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { createHtmlPreviewUrl, handleAppProtocol } from "./protocol.ts";',
      'export { getProtocolHandler } from "electron";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "main-protocol-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  plugins: [
    {
      name: "electron-protocol-mock",
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "protocol-test" }));
        builder.onLoad({ filter: /.*/, namespace: "protocol-test" }, () => ({
          contents: `
            let handler;
            export const app = { getPath() { return ${JSON.stringify(path.join(import.meta.dirname, "../../.artifacts"))}; } };
            export const protocol = {
              registerSchemesAsPrivileged() {},
              handle(_scheme, next) { handler = next; },
            };
            export function getProtocolHandler() { return handler; }
          `,
          loader: "js",
        }));
      },
    },
  ],
});

const { createHtmlPreviewUrl, getProtocolHandler, handleAppProtocol } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

test("HTML preview assets stay inside the source document directory", async () => {
  const loaded = [];
  const previewUrl = createHtmlPreviewUrl("<h1>Preview</h1>", "/workspace/site/index.html", async (filePath) => {
    loaded.push(filePath);
    return { base64: Buffer.from("asset").toString("base64"), size: 5, mime: "text/plain" };
  });
  handleAppProtocol("/renderer");
  const handler = getProtocolHandler();

  const valid = await handler({ url: previewUrl.replace("index.html", "assets/app.js") });
  assert.equal(valid.status, 200);
  assert.deepEqual(loaded, [path.resolve("/workspace/site/assets/app.js")]);

  for (const malicious of [
    "%2e%2e%2Fsecret.txt",
    "nested%2F..%2F..%2Fsecret.txt",
    "%2Fetc/passwd",
    "..%2Fsecret.txt",
    "%E0%A4%A",
  ]) {
    const response = await handler({ url: previewUrl.replace("index.html", malicious) });
    assert.equal(response.status, 403, malicious);
  }
  assert.equal(loaded.length, 1, "rejected paths must not reach the Host asset loader");
});
