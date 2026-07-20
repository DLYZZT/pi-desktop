import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPluginWorker } from "./plugin-worker-client.ts";

const MARKER = "PI_DESKTOP_PLUGIN_WORKER_RESULT:";

function context(revision = 9) {
  return {
    inventoryRevision: revision,
    resolutionId: `resolution-${revision}`,
    cwd: process.cwd(),
    intent: "plugin-install",
    commands: {},
    nativeEnv: { PATH: process.env.PATH ?? "" },
    shellEnv: { PATH: process.env.PATH ?? "" },
  };
}

function fakeWorker(directory, responseExpression) {
  const file = path.join(directory, "worker.mjs");
  writeFileSync(
    file,
    `let input=""; for await (const chunk of process.stdin) input += chunk;\n` +
      `const request=JSON.parse(input);\n` +
      `const response=${responseExpression};\n` +
      `process.stdout.write("noise\\n${MARKER}" + Buffer.from(JSON.stringify(response)).toString("base64") + "\\n");\n`,
    "utf8",
  );
  return file;
}

test("runs Plugins in an isolated process with the selected npm command and revision", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-plugin-worker-"));
  try {
    const entryPath = fakeWorker(
      directory,
      `{ok:true,result:{packages:[],totals:{extensions:0,skills:0,prompts:0,themes:0},diagnostics:[{type:"warning",message:request.npmCommand.join("|")+":"+process.env.PI_DESKTOP_TOOLCHAIN_REVISION}]}}`,
    );
    const result = await runPluginWorker(
      { body: { action: "update", cwd: directory }, npmCommand: [process.execPath, "/npm-cli.js"] },
      context(12),
      { entryPath, execPath: process.execPath, timeoutMs: 5_000 },
    );
    assert.equal(result.diagnostics[0].message, `${process.execPath}|/npm-cli.js:12`);
    assert.equal(process.env.PI_DESKTOP_TOOLCHAIN_REVISION, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes a worker npm ENOENT into TOOLCHAIN_NODE_REQUIRED", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-plugin-worker-error-"));
  try {
    const entryPath = fakeWorker(directory, `{ok:false,error:{code:"TOOLCHAIN_INTERNAL",message:"spawn npm ENOENT"}}`);
    await assert.rejects(
      runPluginWorker({ body: { action: "install", source: "npm:test", cwd: directory } }, context(), {
        entryPath,
        execPath: process.execPath,
        timeoutMs: 5_000,
      }),
      (error) => error.code === "TOOLCHAIN_NODE_REQUIRED" && error.capability === "js.npm",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the worker does not return a bounded protocol response", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-plugin-worker-protocol-"));
  try {
    const entryPath = path.join(directory, "worker.mjs");
    writeFileSync(entryPath, `process.stdout.write("not a response")`, "utf8");
    await assert.rejects(
      runPluginWorker({ body: { action: "update", cwd: directory } }, context(), {
        entryPath,
        execPath: process.execPath,
        timeoutMs: 5_000,
      }),
      (error) => error.code === "TOOLCHAIN_INTERNAL" && /without a result/.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
