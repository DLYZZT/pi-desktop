import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopSearchToolDefinitions, searchToolRuntimeFromContext } from "./toolchain-search.ts";
import { ToolchainRuntime } from "./toolchain-runtime.ts";

const bundledRipgrep = path.join(
  import.meta.dirname,
  "..",
  "..",
  "build",
  "toolchains",
  "core",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "rg.exe" : "rg",
);

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

function ripgrepContext() {
  return context({
    "search.rg": {
      ...command("search.rg", ""),
      executable: bundledRipgrep,
      argvPrefix: [],
      binDir: path.dirname(bundledRipgrep),
    },
  });
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

test("Desktop grep ignores RIPGREP_CONFIG_PATH so regex and literal searches keep their meaning", async (t) => {
  if (!fs.existsSync(bundledRipgrep)) return t.skip("bundled ripgrep is not prepared");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-rgconfig-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "sample.txt"), "alpha123\nalpha[0-9]+\n");
  const config = path.join(root, "ripgreprc");
  fs.writeFileSync(config, "--fixed-strings\n");
  const executionContext = ripgrepContext();
  executionContext.nativeEnv.RIPGREP_CONFIG_PATH = config;
  executionContext.shellEnv.RIPGREP_CONFIG_PATH = config;
  const runtime = new ToolchainRuntime({
    platform: process.platform,
    baseEnv: { ...process.env, RIPGREP_CONFIG_PATH: config },
  });
  const [grep] = createDesktopSearchToolDefinitions(root, executionContext, runtime);
  const text = async (input) =>
    (await grep.execute("grep", { path: ".", ...input }, undefined, undefined, {})).content[0].text;

  assert.match(await text({ pattern: "alpha[0-9]+" }), /sample\.txt:1: alpha123/);
  assert.doesNotMatch(await text({ pattern: "alpha[0-9]+" }), /sample\.txt:2:/);
  const literal = await text({ pattern: "alpha[0-9]+", literal: true });
  assert.match(literal, /sample\.txt:2: alpha\[0-9\]\+/);
  assert.doesNotMatch(literal, /sample\.txt:1:/);
});

test("Desktop grep roots slash globs at the requested directory and prints paths relative to it", async (t) => {
  if (!fs.existsSync(bundledRipgrep)) return t.skip("bundled ripgrep is not prepared");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-glob-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "repo");
  for (const directory of ["migrations/main", "other/migrations/main"]) {
    fs.mkdirSync(path.join(target, directory), { recursive: true });
    fs.writeFileSync(path.join(target, directory, "a.js"), "needle\n");
  }
  fs.symlinkSync(target, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const [grep] = createDesktopSearchToolDefinitions(root, ripgrepContext(), new ToolchainRuntime());
  for (const [searchPath, glob] of [
    ["repo", "migrations/main/*.js"],
    ["alias", "./migrations/main/*.js"],
  ]) {
    const result = await grep.execute("grep", { pattern: "needle", path: searchPath, glob }, undefined, undefined, {});
    assert.equal(result.content[0].text, "migrations/main/a.js:1: needle");
  }
});

test("Desktop grep reports an exceeded limit only for an extra match and retains trailing context", async (t) => {
  if (!fs.existsSync(bundledRipgrep)) return t.skip("bundled ripgrep is not prepared");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-grep-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "sample.txt");
  const [grep] = createDesktopSearchToolDefinitions(root, ripgrepContext(), new ToolchainRuntime());
  const search = (context) =>
    grep.execute("grep", { path: file, pattern: "needle", limit: 1, context }, undefined, undefined, {});

  fs.writeFileSync(file, "before\r\nneedle\r\nafter\r\n");
  const exact = await search(1);
  assert.equal(exact.details, undefined);
  assert.equal(exact.content[0].text, "sample.txt-1- before\nsample.txt:2: needle\nsample.txt-3- after");

  fs.appendFileSync(file, "unused\nneedle extra\nafter omitted match\n");
  const exceeded = await search(1);
  assert.equal(exceeded.details.matchLimitReached, 1);
  assert.ok(exceeded.content[0].text.startsWith(exact.content[0].text + "\n\n["));
  assert.doesNotMatch(exceeded.content[0].text, /unused|needle extra|after omitted match/);

  fs.writeFileSync(file, "before\nneedle\nneedle nearby\nafter nearby\n");
  const adjacent = await search(2);
  assert.equal(adjacent.details.matchLimitReached, 1);
  assert.match(
    adjacent.content[0].text,
    /^sample\.txt-1- before\nsample\.txt:2: needle\nsample\.txt-3- needle nearby\nsample\.txt-4- after nearby\n/,
  );
});

test("Desktop grep keeps full truncation totals when the byte budget is exceeded", async (t) => {
  if (!fs.existsSync(bundledRipgrep)) return t.skip("bundled ripgrep is not prepared");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-grep-bytes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const line = "needle " + "x".repeat(200);
  const count = 350;
  fs.writeFileSync(path.join(root, "sample.txt"), `${line}\n`.repeat(count));
  const [grep] = createDesktopSearchToolDefinitions(root, ripgrepContext(), new ToolchainRuntime());
  const result = await grep.execute("grep", { path: ".", pattern: "needle", limit: count }, undefined, undefined, {});
  const fullOutput = Array.from({ length: count }, (_, index) => `sample.txt:${index + 1}: ${line}`).join("\n");
  assert.equal(result.details.matchLimitReached, undefined);
  assert.equal(result.details.truncation.totalLines, count);
  assert.equal(result.details.truncation.totalBytes, Buffer.byteLength(fullOutput));
  assert.ok(result.details.truncation.outputLines < count);
});
