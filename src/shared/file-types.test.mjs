import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-types.ts");
}

test("detects image, audio, and document preview paths", async () => {
  const { getAudioMime, getDocumentMime, getImageMime, isAudioPath, isDocumentPreviewPath, isImagePath } =
    await loadSubject();

  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(
    getDocumentMime("/tmp/report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(isImagePath("/tmp/screenshot.PNG"), true);
  assert.equal(isAudioPath("C:\\Users\\me\\voice.OPUS"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.pdf"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.txt"), false);
});

test("extracts extensions from mixed path styles", async () => {
  const { documentPreviewKind, getFileExt } = await loadSubject();

  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
  assert.equal(getFileExt("\\\\server\\share\\nested.name\\manual.DOCX"), "docx");
  assert.equal(getFileExt(".env.local"), "local");
  assert.equal(documentPreviewKind("/tmp/manual.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/manual.md"), null);
});

test("does not invent extensions for bare names, dotfiles, trailing dots, or directories", async () => {
  const { getFileExt, getImageMime, isImagePath } = await loadSubject();

  for (const filePath of ["png", "/tmp/png", ".png", "/tmp/.env", "file.", "C:\\tmp\\photo.", "/tmp/"]) {
    assert.equal(getFileExt(filePath), "", filePath);
  }
  assert.equal(getImageMime("png"), null);
  assert.equal(isImagePath("png"), false);
  assert.equal(getImageMime(".png"), null);
  assert.equal(isImagePath("/tmp/actual.png"), true);
});
