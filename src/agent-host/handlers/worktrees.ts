import { existsSync } from "node:fs";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import {
  addWorktree,
  getGitStatus,
  isDirtyWorktreeError,
  listWorktrees,
  removeWorktree,
  resolveProject,
} from "../../shared/worktree";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "../file-access";
import { assertPathAllowed } from "../path-authorization";
import type { ManagedProcessService } from "../managed-process/service";

type WorktreeHandlers = {
  list: NonNullable<ApiHandler["worktrees.list"]>;
  create: NonNullable<ApiHandler["worktrees.create"]>;
  remove: NonNullable<ApiHandler["worktrees.remove"]>;
  status: NonNullable<ApiHandler["git.status"]>;
};

export function createWorktreeHandlers(managedProcesses: Pick<ManagedProcessService, "activeWithinCwd">) {
  return {
    list: async (params) => {
      const { projectRoot } = params as { projectRoot: string };
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(projectRoot, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const project = await resolveProject(projectRoot);
      let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
      let isGit = true;
      try {
        worktrees = await listWorktrees(existsSync(projectRoot) ? projectRoot : project.projectRoot);
      } catch {
        isGit = false;
      }
      for (const w of worktrees) allowFileRoot(w.path);
      return {
        worktrees,
        projectRoot: project.projectRoot,
        isGit,
        isTopLevel: project.isTopLevel,
      };
    },

    create: async (params) => {
      const body = params as { projectRoot: string; branch: string; cwd?: string };
      const cwd = body.cwd ?? body.projectRoot;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const result = await addWorktree(cwd, body.branch);
      allowFileRoot(result.path);
      return { worktree: result };
    },

    remove: async (params) => {
      const body = params as { path: string; cwd?: string; force?: boolean };
      const cwd = body.cwd ?? body.path;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const activeProcesses = managedProcesses.activeWithinCwd(body.path);
      if (activeProcesses.length > 0) {
        throw new RpcError({
          code: "CONFLICT",
          message: "Worktree still contains active managed processes. Stop them before removing it.",
          detail: { managedProcessCount: activeProcesses.length },
        });
      }
      try {
        await removeWorktree(cwd, body.path, body.force === true);
      } catch (error) {
        if (!body.force && isDirtyWorktreeError(error)) {
          throw new RpcError({
            code: "CONFLICT",
            message: error instanceof Error ? error.message : String(error),
            detail: { dirty: true },
          });
        }
        throw error;
      }
      return { ok: true as const };
    },

    status: async (params) => {
      const { path: cwd } = params as { path: string };
      await assertPathAllowed(cwd);
      return getGitStatus(cwd);
    },
  } satisfies WorktreeHandlers;
}
