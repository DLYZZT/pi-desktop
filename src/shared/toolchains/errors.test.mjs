import assert from "node:assert/strict";
import test from "node:test";

import { asToolchainError, publicToolchainError, ToolchainError, toolchainCauseCode } from "./errors.ts";

test("preserves stable toolchain metadata without exposing an arbitrary cause", () => {
  const cause = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  const error = asToolchainError(cause, {
    code: "TOOLCHAIN_NODE_REQUIRED",
    message: "Node.js is required",
    capability: "js.node",
  });

  assert.equal(error.code, "TOOLCHAIN_NODE_REQUIRED");
  assert.equal(error.capability, "js.node");
  assert.equal(error.causeCode, "ENOENT");
  assert.deepEqual(publicToolchainError(error), {
    code: "TOOLCHAIN_NODE_REQUIRED",
    message: "Node.js is required",
  });
});

test("bounds low-level cause codes and normalizes unknown failures", () => {
  assert.equal(toolchainCauseCode({ code: "EACCES" }), "EACCES");
  assert.equal(toolchainCauseCode({ code: "x".repeat(65) }), undefined);
  assert.equal(toolchainCauseCode(null), undefined);

  assert.deepEqual(publicToolchainError(new Error("failed")), {
    code: "TOOLCHAIN_INTERNAL",
    message: "failed",
  });
  assert.equal(new ToolchainError({ code: "TOOLCHAIN_CANCELLED", message: "Cancelled" }).name, "ToolchainError");
});
