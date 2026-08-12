import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { installActionForIssue, parseCapabilityIssue } = await importTestBundle(
  "src/renderer/components/capability-required",
  {
    stdin: {
      contents: 'export { installActionForIssue, parseCapabilityIssue } from "./CapabilityRequired.tsx";',
      resolveDir: import.meta.dirname,
      sourcefile: "capability-required-test-entry.tsx",
      loader: "tsx",
    },
    tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
    external: ["react", "react-dom", "react-dom/*"],
  },
);

test("parses structured capability errors and never guesses from raw ENOENT text", () => {
  assert.deepEqual(
    parseCapabilityIssue({
      error: "Node unavailable",
      code: "TOOLCHAIN_NODE_REQUIRED",
      capability: "js.npx",
    }),
    {
      code: "TOOLCHAIN_NODE_REQUIRED",
      capability: "js.npx",
      message: "Node unavailable",
    },
  );
  assert.deepEqual(parseCapabilityIssue({ code: "TOOLCHAIN_PYTHON_REQUIRED" }), {
    code: "TOOLCHAIN_PYTHON_REQUIRED",
    capability: "python.interpreter",
    message: undefined,
  });
  assert.equal(parseCapabilityIssue({ error: "spawn npm ENOENT" }), null);
  assert.deepEqual(parseCapabilityIssue({ code: "TOOLCHAIN_CAPABILITY_REQUIRED", capability: "js.pnpm" }), {
    code: "TOOLCHAIN_CAPABILITY_REQUIRED",
    capability: undefined,
    message: undefined,
  });
  assert.equal(parseCapabilityIssue({ code: "BAD_REQUEST", error: "bad input" }), null);
});

test("recommends only the managed component that can satisfy the missing capability", () => {
  assert.deepEqual(installActionForIssue({ code: "TOOLCHAIN_CAPABILITY_REQUIRED", capability: "js.bun" }, "linux"), {
    action: "install-component",
    componentId: "bun",
  });
  assert.deepEqual(installActionForIssue({ code: "TOOLCHAIN_NODE_REQUIRED", capability: "js.npx" }, "darwin"), {
    action: "install-profile",
    profileId: "javascript-essentials",
  });
});
