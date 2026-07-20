import type { GitCommandRunner } from "../shared/worktree.ts";
import { setGitCommandRunner } from "../shared/worktree.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

export function createToolchainGitRunner(runtime: ToolchainRuntime = toolchainRuntime): GitCommandRunner {
  return {
    async run(cwd, args, options) {
      const result = await runtime.exec("vcs.git", ["-C", cwd, ...args], {
        cwd,
        intent: "git-operation",
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      });
      return { stdout: result.stdout };
    },
  };
}

export function installToolchainGitRunner(runtime: ToolchainRuntime = toolchainRuntime): () => void {
  return setGitCommandRunner(createToolchainGitRunner(runtime));
}
