import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectLocalFiles,
  validateFileContextRequest,
  validateFileContextRequestResult,
} from "./file-context-policy.ts";

test("file context validation resolves real paths and enforces project containment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-file-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "repo");
  const sibling = path.join(root, "repo-secret");
  await Promise.all([mkdir(project), mkdir(sibling)]);
  const inside = path.join(project, "inside.txt");
  const outside = path.join(sibling, "outside.txt");
  await Promise.all([writeFile(inside, "inside"), writeFile(outside, "outside")]);

  const insideTarget = await validateFileContextRequest({
    href: inside,
    cwd: project,
    source: "local-file-reference",
  });
  assert.equal(insideTarget.insideCwd, true);
  assert.equal(insideTarget.allowCopyContents, true);

  const outsideTarget = await validateFileContextRequest({
    href: outside,
    cwd: project,
    source: "rendered-agent-text",
  });
  assert.equal(outsideTarget.insideCwd, false);
  assert.equal(outsideTarget.allowCopyContents, false);

  if (process.platform !== "win32") {
    const link = path.join(project, "outside-link.txt");
    await symlink(outside, link);
    const linkTarget = await validateFileContextRequest({ href: link, cwd: project, source: "rendered-agent-text" });
    assert.equal(linkTarget.insideCwd, false, "realpath containment blocks symlink escape");
  }
});

test("file context validation rejects untrusted shapes, missing files, and non-file URLs", async () => {
  assert.equal(await validateFileContextRequest(null), null);
  assert.equal(await validateFileContextRequest({ href: "relative.txt", source: "rendered-agent-text" }), null);
  assert.equal(
    await validateFileContextRequest({ href: "https://example.com/a", source: "rendered-agent-text" }),
    null,
  );
  assert.equal(await validateFileContextRequest({ href: "/missing/file.txt", source: "unknown" }), null);
  assert.deepEqual(await validateFileContextRequestResult({ href: "relative.txt", source: "rendered-agent-text" }), {
    ok: false,
    code: "INVALID_REQUEST",
  });
  assert.deepEqual(
    await validateFileContextRequestResult({ href: "/definitely/missing", source: "rendered-agent-text" }),
    {
      ok: false,
      code: "NOT_FOUND",
    },
  );
});

test("file inspection reports missing, file type, and containment without throwing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-file-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "file.txt");
  await writeFile(file, "content");
  const result = await inspectLocalFiles({ paths: [file, path.join(root, "missing.txt")], cwd: root });
  assert.deepEqual(
    result.map(({ exists, isFile, insideCwd }) => ({ exists, isFile, insideCwd })),
    [
      { exists: true, isFile: true, insideCwd: true },
      { exists: false, isFile: false, insideCwd: false },
    ],
  );
});
