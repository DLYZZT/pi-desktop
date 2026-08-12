import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const { collectOutboundFiles } = await importTestBundle("src/agent-host/channels/outbound-files", {
  packages: "external",
  stdin: {
    contents: 'export { collectOutboundFiles } from "./outbound-files.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "outbound-files-test-entry.ts",
    loader: "ts",
  },
});

test("explicitly linked existing and newly created workspace files are authorized for IM delivery", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-outbound-files-"));
  const oldPath = path.join(cwd, "old.txt");
  const newPath = path.join(cwd, "result.png");
  await writeFile(oldPath, "old secret");
  const oldTime = new Date(Date.now() - 60_000);
  await utimes(oldPath, oldTime, oldTime);
  await writeFile(newPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const result = await collectOutboundFiles({
    cwd,
    finalText: `完成：[结果](${newPath})；[旧文件](${oldPath})；[网页](https://example.com)。`,
  });
  assert.deepEqual(result.attachments, [
    { kind: "image", path: await realpath(newPath), name: "result.png", mime: "image/png" },
    { kind: "file", path: await realpath(oldPath), name: "old.txt", mime: "text/plain" },
  ]);
  assert.equal(result.text, "完成：📎 结果；📎 旧文件；[网页](https://example.com)。");
  assert.equal(result.text.includes(cwd), false);
});

test("symlinks escaping the bound workspace are never authorized", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-outbound-root-"));
  const outside = path.join(tmpdir(), `pi-outside-${process.pid}.txt`);
  await writeFile(outside, "outside");
  const link = path.join(cwd, "outside.txt");
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, link);
  const result = await collectOutboundFiles({
    cwd,
    finalText: `[outside](${link})`,
  });
  assert.deepEqual(result.attachments, []);
  assert.equal(result.text, "📎 outside（未发送）");
});
