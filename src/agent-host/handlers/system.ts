import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { allowFileRoot } from "../file-access";
import { getRunningRpcSessionIds } from "../rpc-manager";
import { validateExistingDirectory } from "../directory-validation";

type SystemHandlers = {
  home: NonNullable<ApiHandler["system.home"]>;
  validateCwd: NonNullable<ApiHandler["system.validateCwd"]>;
  defaultCwd: NonNullable<ApiHandler["system.defaultCwd"]>;
  allowRoot: NonNullable<ApiHandler["system.allowRoot"]>;
  runningCount: NonNullable<ApiHandler["system.runningCount"]>;
};

export const systemHandlers = {
  home: () => ({ home: homedir() }),

  validateCwd: async (params) => {
    const { path: dir } = params as { path: string };
    const validation = validateExistingDirectory(dir);
    if (!validation.ok) return validation;
    allowFileRoot(validation.canonicalPath);
    return { ok: true as const, path: validation.path };
  },

  defaultCwd: async () => {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = path.join(homedir(), `pi-cwd-${date}`);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return { cwd: dir };
  },

  allowRoot: async (params) => {
    const { path: dir } = params as { path: string };
    const validation = validateExistingDirectory(dir);
    if (!validation.ok) throw new RpcError({ code: "BAD_REQUEST", message: validation.error });
    allowFileRoot(validation.canonicalPath);
    return { ok: true as const };
  },

  runningCount: async () => {
    const sessionIds = getRunningRpcSessionIds();
    return { count: sessionIds.length, sessionIds };
  },
} satisfies SystemHandlers;
