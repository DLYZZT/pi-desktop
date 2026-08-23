import { createLocalBashOperations, type BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionContext } from "../shared/toolchains/types.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";
import { sanitizeToolEnvironment } from "./tool-environment.ts";

/** Build Bash options from one immutable project resolution. */
export function createToolchainBashOptions(
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
  commandPrefix?: string,
  beforeExec?: (command: string) => Promise<void>,
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
  const local = createLocalBashOperations({ shellPath: descriptor.executable });
  return {
    commandPrefix,
    shellPath: descriptor.executable,
    operations: {
      async exec(command, cwd, options) {
        await beforeExec?.(command);
        return local.exec(command, cwd, options);
      },
    },
    spawnHook(spawnContext) {
      return {
        ...spawnContext,
        env: sanitizeToolEnvironment({ ...spawnContext.env, ...context.shellEnv }),
      };
    },
  };
}
