import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { execDesktopBash } from "./desktop-bash-exec.ts";

const source = readFileSync(new URL("./desktop-bash-exec.ts", import.meta.url), "utf8");

test("desktop bash waits on exit plus stdio idle, not close-only", () => {
  assert.match(source, /EXIT_STDIO_GRACE_MS/);
  assert.match(source, /child\.once\("exit"/);
  assert.doesNotMatch(source, /function waitForClose/);
});

const gitBash = process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : "";

test(
  "abort kills a long Windows bash child instead of leaving it running",
  { skip: !gitBash || !existsSync(gitBash) },
  async () => {
    const controller = new globalThis.AbortController();
    const started = Date.now();
    const run = execDesktopBash(
      "ping -n 30 127.0.0.1",
      process.cwd(),
      {
        onData() {},
        signal: controller.signal,
      },
      gitBash,
    );
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(run, /aborted/);
    assert.ok(Date.now() - started < 8_000);
  },
);
