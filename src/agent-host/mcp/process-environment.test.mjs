import assert from "node:assert/strict";
import test from "node:test";
import { mcpProcessEnvironment } from "./process-environment.ts";

test("Windows MCP uses native paths and applies environment overrides case-insensitively", () => {
  const context = {
    nativeEnv: { Path: "C:\\native", SystemRoot: "C:\\Windows", TOKEN: "base" },
    shellEnv: { PATH: "/c/msys/bin", MSYSTEM: "MINGW64" },
  };
  assert.deepEqual(mcpProcessEnvironment("win32", context, { PATH: "C:\\custom", token: "override" }), {
    PATH: "C:\\custom",
    SystemRoot: "C:\\Windows",
    token: "override",
  });
  assert.equal(context.nativeEnv.Path, "C:\\native");
});

test("MCP child environments never forward inherited Electron Node mode", () => {
  const context = {
    nativeEnv: { ELECTRON_RUN_AS_NODE: "1", Path: "native" },
    shellEnv: { ELECTRON_RUN_AS_NODE: "1", PATH: "shell" },
  };
  for (const platform of ["win32", "linux", "darwin"]) {
    const environment = mcpProcessEnvironment(platform, context, { electron_run_as_node: "1", EMPTY: undefined });
    assert.equal(
      Object.keys(environment).some((key) => key.toLowerCase() === "electron_run_as_node"),
      false,
    );
    assert.equal("EMPTY" in environment, false);
  }
});

test("POSIX MCP retains shell paths and case-sensitive variables", () => {
  assert.deepEqual(
    mcpProcessEnvironment("linux", { nativeEnv: { PATH: "native" }, shellEnv: { PATH: "shell" } }, { Path: "other" }),
    { PATH: "shell", Path: "other" },
  );
});
