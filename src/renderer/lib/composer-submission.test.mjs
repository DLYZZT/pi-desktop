import assert from "node:assert/strict";
import test from "node:test";

import {
  captureComposerSubmission,
  failedComposerSubmissionAction,
  mergeFailedSubmissionFiles,
  mergeFailedSubmissionImages,
} from "./composer-submission.ts";

function image(data, previewUrl = `blob:${data}`) {
  return { data, mimeType: "image/png", previewUrl };
}

test("submission snapshots use durable previews before composer URLs are revoked", () => {
  assert.deepEqual(captureComposerSubmission("hello", [image("abc")]), {
    value: "hello",
    images: [{ data: "abc", mimeType: "image/png", previewUrl: "data:image/png;base64,abc" }],
    files: [],
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

test("failed local file references merge by normalized platform path", () => {
  assert.deepEqual(
    mergeFailedSubmissionFiles(
      [{ name: "new", path: "C:\\Work\\new.txt" }],
      [
        { name: "same", path: "c:/work/new.txt" },
        { name: "old", path: "/tmp/old.txt" },
      ],
    ),
    [
      { name: "new", path: "C:\\Work\\new.txt" },
      { name: "old", path: "/tmp/old.txt" },
    ],
  );
});
