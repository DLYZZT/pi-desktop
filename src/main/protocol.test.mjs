import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const {
  HTML_PREVIEW_MAX_ENTRIES,
  HTML_PREVIEW_TTL_MS,
  createHtmlPreviewUrl,
  getProtocolHandler,
  handleAppProtocol,
  pruneHtmlPreviews,
  releaseHtmlPreviewsForOwner,
} = await importTestBundle("src/main/protocol", {
  stdin: {
    contents: [
      'export { HTML_PREVIEW_MAX_ENTRIES, HTML_PREVIEW_TTL_MS, createHtmlPreviewUrl, handleAppProtocol, pruneHtmlPreviews, releaseHtmlPreviewsForOwner } from "./protocol.ts";',
      'export { getProtocolHandler } from "electron";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "main-protocol-test-entry.ts",
    loader: "ts",
  },
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

test("HTML preview registry expires, caps, and releases owned entries", async () => {
  const loader = async () => ({ base64: "", size: 0 });
  const createdAt = Date.now();
  const expiredUrl = createHtmlPreviewUrl("expired", "/workspace/expired.html", loader, 10);
  const ownedUrl = createHtmlPreviewUrl("owned", "/workspace/owned.html", loader, 20);
  const retainedUrl = createHtmlPreviewUrl("retained", "/workspace/retained.html", loader, 30);

  pruneHtmlPreviews(createdAt + HTML_PREVIEW_TTL_MS + 1);
  assert.equal((await getProtocolHandler()({ url: expiredUrl })).status, 404);

  const freshOwnedUrl = createHtmlPreviewUrl("owned", "/workspace/owned.html", loader, 20);
  const freshRetainedUrl = createHtmlPreviewUrl("retained", "/workspace/retained.html", loader, 30);
  releaseHtmlPreviewsForOwner(20);
  assert.equal((await getProtocolHandler()({ url: freshOwnedUrl })).status, 404);
  assert.equal((await getProtocolHandler()({ url: freshRetainedUrl })).status, 200);

  const capacityUrls = [];
  for (let index = 0; index <= HTML_PREVIEW_MAX_ENTRIES; index += 1) {
    capacityUrls.push(createHtmlPreviewUrl(String(index), `/workspace/${index}.html`, loader, 40));
  }
  assert.equal((await getProtocolHandler()({ url: capacityUrls[0] })).status, 404);
  assert.equal((await getProtocolHandler()({ url: capacityUrls.at(-1) })).status, 200);

  releaseHtmlPreviewsForOwner(10);
  releaseHtmlPreviewsForOwner(20);
  releaseHtmlPreviewsForOwner(30);
  releaseHtmlPreviewsForOwner(40);
  void ownedUrl;
  void retainedUrl;
});
