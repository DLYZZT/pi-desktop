import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const toolsSource = await readFile(new URL("./tools.ts", import.meta.url), "utf8");

test("managed process tools activate only with a non-empty local tool selection", async () => {
  const { withExtensionTools } = await importTestBundle("src/agent-host/rpc-manager", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/rpc-manager.ts"],
  });
  const session = {
    getAllTools() {
      return [
        { name: "read" },
        { name: "browser_open" },
        { name: "process_start" },
        { name: "process_stop" },
        { name: "extension_tool" },
      ];
    },
  };
  assert.deepEqual(withExtensionTools(session, []), []);
  assert.deepEqual(withExtensionTools(session, ["read"]), ["read", "process_start", "process_stop", "extension_tool"]);
});

test("managed process tools reject messaging-channel turns and bound literal waits", () => {
  assert.match(toolsSource, /getBrowserSessionSource\(ctx\.sessionManager\) === "channel"/);
  assert.match(toolsSource, /maxLength: 256/);
  assert.match(toolsSource, /same runId and returned nextCursor/);
});
