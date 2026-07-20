import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionContext } from "../shared/toolchains/types.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

/** Build Bash options from one immutable project resolution. */
export function createToolchainBashOptions(
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
  commandPrefix?: string,
): BashToolOptions {
  const descriptor = context.commands["shell.bash"];
  if (!descriptor) {
    return {
      commandPrefix,
      operations: {
        async exec() {
          runtime.requireFromContext("shell.bash", context);
          return { exitCode: null };
        },
      },
    };
  }
  return {
    commandPrefix,
    shellPath: descriptor.executable,
    spawnHook(spawnContext) {
      return {
        ...spawnContext,
        env: { ...spawnContext.env, ...context.shellEnv },
      };
    },
  };
}
