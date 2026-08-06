import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { safeDownloadPath, sanitizeDownloadFilename } from "./browser-download-manager.ts";

test("download filenames are normalized and cannot traverse the approved directory", () => {
  assert.equal(sanitizeDownloadFilename("../../secret.txt"), "secret.txt");
  assert.equal(sanitizeDownloadFilename("a<b>c?.txt"), "a_b_c_.txt");
  assert.equal(sanitizeDownloadFilename("\0\n"), "download");
  const root = path.resolve("/tmp/downloads");
  assert.equal(safeDownloadPath(root, "../report.txt"), path.join(root, "report.txt"));
});
