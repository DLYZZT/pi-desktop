import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { DRAFT_IMAGE_TARGET_BYTES, compressDraftImage, processImageFileBatch } from "./image-file-processing.ts";

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

test("compressDraftImage leaves small images unchanged without canvas APIs", async () => {
  const small = { data: "YQ==", mimeType: "image/png" };
  assert.deepEqual(await compressDraftImage(small), small);

  const large = {
    data: "A".repeat(Math.ceil(((DRAFT_IMAGE_TARGET_BYTES + 1) * 4) / 3)),
    mimeType: "image/png",
  };
  assert.deepEqual(await compressDraftImage(large), large);
});

test("oversized screenshots are compressed before they enter the draft", async () => {
  const files = [file("shot")];
  const payload = "A".repeat(Math.ceil(((DRAFT_IMAGE_TARGET_BYTES + 1) * 4) / 3));
  const result = await processImageFileBatch(files, {
    readAsDataUrl: async () => `data:image/png;base64,${payload}`,
    createObjectUrl: (item) => `blob:${item.name}`,
    revokeObjectUrl() {},
    compressImage: async () => ({ data: "YQ==", mimeType: "image/jpeg" }),
  });

  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.images, [{ data: "YQ==", mimeType: "image/jpeg", previewUrl: "blob:shot" }]);
});

test("ChatInput preserves successes, reports failures, and owns pending previews", () => {
  const source = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /const \{ images, failures \} = await processImageFileBatch\(imageFiles\)/);
  assert.match(source, /selectDraftImageAdditions\(attachedImagesRef\.current, images\)/);
  assert.match(source, /selection\.rejected\.forEach\(\(\{ image \}\) => revokeImagePreview\(image\)\)/);
  assert.match(source, /role="alert"/);
  assert.match(
    source,
    /selection\.accepted\.forEach\(\(image\) => pendingImagePreviewsRef\.current\.add\(image\.previewUrl\)\)/,
  );
  assert.match(source, /for \(const previewUrl of pendingPreviews\) URL\.revokeObjectURL\(previewUrl\)/);
});
