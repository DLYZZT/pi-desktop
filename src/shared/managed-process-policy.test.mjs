import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ManagedProcessPolicyError,
  extractManagedLoopbackEndpoints,
  normalizeManagedProcessLabel,
  resolveManagedProcessCwd,
  sanitizeManagedProcessText,
  validateManagedProcessCommand,
} from "./managed-process-policy.ts";

test("command policy blocks detach patterns and LAN binds", () => {
  for (const command of [
    "npm run dev &",
    "npm run dev & echo escaped",
    "nohup npm run dev",
    "setsid npm run dev",
    "systemd-run npm run dev",
    "launchctl submit npm-run-dev",
    "open -a Terminal npm run dev",
    "Start-Process npm",
  ]) {
    assert.throws(() => validateManagedProcessCommand(command), ManagedProcessPolicyError, command);
  }
  assert.throws(
    () => validateManagedProcessCommand("vite --host 0.0.0.0"),
    (error) => error.code === "PROCESS_CONFIRMATION_REQUIRED",
  );
  assert.equal(validateManagedProcessCommand("npm run dev -- --host 127.0.0.1"), "npm run dev -- --host 127.0.0.1");
  assert.equal(validateManagedProcessCommand("npm run dev 2>&1"), "npm run dev 2>&1");
});

test("cwd must remain under real owner root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-managed-policy-"));
  const child = path.join(root, "packages", "app");
  const outside = await mkdtemp(path.join(tmpdir(), "pi-managed-outside-"));
  await mkdir(child, { recursive: true });
  assert.equal(await resolveManagedProcessCwd(root, "packages/app"), await realpath(child));
  await symlink(outside, path.join(root, "escape"));
  await assert.rejects(() => resolveManagedProcessCwd(root, "escape"), ManagedProcessPolicyError);
});

test("output is sanitized and loopback URLs are credential safe", () => {
  const text = sanitizeManagedProcessText(
    "\u001b[31mTOKEN=abc Authorization: Bearer top-secret --api-key cli-secret " +
      "ghp_123456789012345678901234567890 https://user:pass@localhost:5173/?token=secret#x",
  );
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("TOKEN=abc"), false);
  assert.equal(text.includes("top-secret"), false);
  assert.equal(text.includes("cli-secret"), false);
  assert.equal(text.includes("ghp_"), false);
  const [endpoint] = extractManagedLoopbackEndpoints(
    "Local: http://localhost:5173/?token=secret#fragment",
    "stdout",
    "run-a",
    1,
  );
  assert.equal(endpoint.url, "http://localhost:5173/?token=%5Bredacted%5D");
  assert.equal(endpoint.firstSeenAt, 1);
});

test("label removes control characters and is bounded", () => {
  const label = normalizeManagedProcessLabel(`dev\u0000${"x".repeat(200)}`, "npm run dev");
  assert.equal(label.includes("\u0000"), false);
  assert.equal([...label].length, 80);
});
