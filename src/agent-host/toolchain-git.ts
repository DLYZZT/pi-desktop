import type { GitCommandRunner } from "../shared/worktree.ts";
import { invalidateProjectCache, setGitCommandRunner } from "../shared/worktree.ts";
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

export function installToolchainGitRunner(
  runtime: ToolchainRuntime = toolchainRuntime,
  onProjectInfoChanged?: () => void,
): () => void {
  const restore = setGitCommandRunner(createToolchainGitRunner(runtime));
  const unsubscribe = runtime.subscribeRevision(() => {
    invalidateProjectCache();
    onProjectInfoChanged?.();
  });
  return () => {
    unsubscribe();
    restore();
  };
}
