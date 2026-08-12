import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { processImageFileBatch } from "./image-file-processing.ts";

function file(name) {
  return { name, type: "image/png" };
}

test("a failed image is isolated and its preview URL is revoked", async () => {
  const files = [file("first"), file("broken"), file("last")];
  const revoked = [];
  const result = await processImageFileBatch(files, {
    async readAsDataUrl(item) {
      if (item.name === "broken") throw new Error("reader failed");
      return `data:${item.type};base64,${item.name}-data`;
    },
    createObjectUrl: (item) => `blob:${item.name}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });

  assert.deepEqual(
    result.images.map((image) => image.previewUrl),
    ["blob:first", "blob:last"],
  );
  assert.deepEqual(
    result.failures.map((failure) => failure.file.name),
    ["broken"],
  );
  assert.deepEqual(revoked, ["blob:broken"]);
});

test("malformed reader output revokes every unusable preview", async () => {
  const files = [file("one"), file("two")];
  const revoked = [];
  const result = await processImageFileBatch(files, {
    readAsDataUrl: async () => "not-a-data-url",
    createObjectUrl: (item) => `blob:${item.name}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });

  assert.equal(result.images.length, 0);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(revoked.sort(), ["blob:one", "blob:two"]);
});

test("ChatInput preserves successes, reports failures, and owns pending previews", () => {
  const source = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /const \{ images, failures \} = await processImageFileBatch\(imageFiles\)/);
  assert.match(source, /setAttachedImages\(\(prev\) => \[\.\.\.prev, \.\.\.images\]\)/);
  assert.match(source, /role="alert"/);
  assert.match(source, /pendingImagePreviewsRef\.current\.add\(image\.previewUrl\)/);
  assert.match(source, /for \(const previewUrl of pendingPreviews\) URL\.revokeObjectURL\(previewUrl\)/);
});
