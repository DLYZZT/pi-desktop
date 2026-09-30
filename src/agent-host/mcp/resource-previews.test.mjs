import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpResourcePreviews } = await importTestBundle("mcp-resource-previews", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "resource-previews.ts")],
});

test("settings resource previews retain bounded content, reject expired references and clean up on shutdown", async (t) => {
  const previews = new McpResourcePreviews(8192);
  t.after(() => previews.dispose());
  const first = await previews.payload({ original: "界".repeat(1700) });
  assert.ok((await previews.content(first.ref.hash, 0)).text.includes("界"));
  const second = await previews.payload({ original: "好".repeat(1700) });
  await assert.rejects(previews.content(first.ref.hash, 0), /expired/);
  assert.ok((await previews.content(second.ref.hash, 0)).text.includes("好"));
  await previews.dispose();
  assert.equal(existsSync(previews.root), false);
  await assert.rejects(previews.payload({ original: true }), /closed/);
});
