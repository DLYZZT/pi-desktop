import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateUploadPaths } from "./browser-upload-paths.ts";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-upload-"));
}

test("accepts existing absolute regular files", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "report.csv");
    fs.writeFileSync(file, "a,b\n1,2\n");
    assert.deepEqual(validateUploadPaths([file]), [file]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relative, missing, directory and duplicate paths", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "report.csv");
    fs.writeFileSync(file, "a,b\n");
    assert.throws(
      () => validateUploadPaths(["report.csv"]),
      (error) => error.code === "UPLOAD_PATH_DENIED",
    );
    assert.throws(
      () => validateUploadPaths([path.join(root, "missing.csv")]),
      (error) => error.code === "UPLOAD_PATH_DENIED",
    );
    assert.throws(
      () => validateUploadPaths([root]),
      (error) => error.code === "UPLOAD_PATH_DENIED",
    );
    assert.throws(
      () => validateUploadPaths([file, file]),
      (error) => error.code === "UPLOAD_PATH_DENIED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects empty batches and too many files", () => {
  assert.throws(
    () => validateUploadPaths([]),
    (error) => error.code === "UPLOAD_PATH_DENIED",
  );
  const root = tempRoot();
  try {
    const files = Array.from({ length: 21 }, (_, index) => {
      const file = path.join(root, `file-${index}.txt`);
      fs.writeFileSync(file, "x");
      return file;
    });
    assert.throws(
      () => validateUploadPaths(files),
      (error) => error.code === "UPLOAD_PATH_DENIED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
