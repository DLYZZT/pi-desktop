import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopSearchToolDefinitions, searchToolRuntimeFromContext } from "./toolchain-search.ts";
import { ToolchainRuntime } from "./toolchain-runtime.ts";

function command(capability, script) {
  return {
    capability,
    provider: "bundled",
    executable: process.execPath,
    argvPrefix: ["-e", script, "--"],
    binDir: path.dirname(process.execPath),
    version: "test",
    cwdSemantics: process.platform === "win32" ? "native" : "posix",
    envPatch: {},
  };
}

function context(commands) {
  return {
    inventoryRevision: 4,
    resolutionId: "search-test",
    nativeEnv: { ...process.env, PI_DESKTOP_TOOLCHAIN_REVISION: "4" },
    shellEnv: { ...process.env, PI_DESKTOP_TOOLCHAIN_REVISION: "4" },
    commands,
    summary: [],
  };
}

test("Desktop grep/find use only injected absolute descriptors and disable upstream downloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-runtime-"));
  try {
    const source = path.join(root, "src");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "match.ts"), "needle\n");
    const rgScript = String.raw`
      const path = require("node:path");
      const root = process.argv.at(-1);
      process.stdout.write(JSON.stringify({type:"match",data:{path:{text:path.join(root,"match.ts")},lines:{text:"needle\n"},line_number:1}})+"\n");
    `;
    const fdScript = String.raw`
      const path = require("node:path");
      const root = process.argv.at(-1);
      process.stdout.write(path.join(root,"match.ts")+"\0");
    `;
    const executionContext = context({
      "search.rg": command("search.rg", rgScript),
      "search.fd": command("search.fd", fdScript),
    });
    const runtime = new ToolchainRuntime({ platform: process.platform, baseEnv: process.env });
    const searchRuntime = searchToolRuntimeFromContext(executionContext);
    assert.equal(searchRuntime.rgPath, process.execPath);
    assert.equal(searchRuntime.fdPath, process.execPath);
    assert.equal(searchRuntime.allowUpstreamDownload, false);

    const [grep, find] = createDesktopSearchToolDefinitions(root, executionContext, runtime);
    const grepResult = await grep.execute("grep-1", { pattern: "needle", path: "src" }, undefined, undefined, {});
    assert.match(grepResult.content[0].text, /^match\.ts:1: needle/);

    const findResult = await find.execute("find-1", { pattern: "*.ts", path: "src" }, undefined, undefined, {});
    assert.equal(findResult.content[0].text, "match.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing injected search capabilities fail closed instead of invoking upstream ensureTool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-runtime-missing-"));
  try {
    const runtime = new ToolchainRuntime({ platform: process.platform, baseEnv: process.env });
    const [grep, find] = createDesktopSearchToolDefinitions(root, context({}), runtime);
    await assert.rejects(
      grep.execute("grep-2", { pattern: "needle" }, undefined, undefined, {}),
      (error) => error.code === "TOOLCHAIN_CAPABILITY_REQUIRED" && error.capability === "search.rg",
    );
    await assert.rejects(
      find.execute("find-2", { pattern: "*.ts" }, undefined, undefined, {}),
      (error) => error.code === "TOOLCHAIN_CAPABILITY_REQUIRED" && error.capability === "search.fd",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
