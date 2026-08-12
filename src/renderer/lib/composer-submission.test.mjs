import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  captureComposerSubmission,
  failedComposerSubmissionAction,
  mergeFailedSubmissionImages,
} from "./composer-submission.ts";

function image(data, previewUrl = `blob:${data}`) {
  return { data, mimeType: "image/png", previewUrl };
}

test("submission snapshots use durable previews before composer URLs are revoked", () => {
  assert.deepEqual(captureComposerSubmission("hello", [image("abc")]), {
    value: "hello",
    images: [{ data: "abc", mimeType: "image/png", previewUrl: "data:image/png;base64,abc" }],
  });
});

test("failed submissions restore only while the cleared composer revision is unchanged", () => {
  assert.equal(failedComposerSubmissionAction(4, 4), "restore");
  assert.equal(failedComposerSubmissionAction(4, 5), "preserve");
});

test("failed attachments merge into a newer draft without duplicates", () => {
  assert.deepEqual(mergeFailedSubmissionImages([image("new"), image("same")], [image("old"), image("same")]), [
    image("new"),
    image("same"),
    image("old", "data:image/png;base64,old"),
  ]);
});

test("ChatInput clears before awaiting and never settles by overwriting a newer revision", () => {
  const source = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /clearInput\(\);\s*const clearedAtRevision = inputRevisionRef\.current;/);
  assert.match(source, /failedComposerSubmissionAction\(clearedAtRevision, inputRevisionRef\.current\)/);
  assert.doesNotMatch(source, /catch \{\s*setValue\(snapshot/);
});
