import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { applyPluginAction, readPlugins } from "../plugins-service";
import { installSkill, searchSkills } from "../skills-service";
import { updateSkillModelInvocation } from "../skill-frontmatter";
import { ToolchainError } from "../../shared/toolchains/errors";
import { toolchainRuntime } from "../toolchain-runtime";
import { cacheWarmingSettings, isCacheWarmingMode } from "../cache-warming-settings";

async function resolveLoadedSkill(cwd: string, filePath: string) {
  if (!cwd || !filePath) {
    throw new RpcError({ code: "BAD_REQUEST", message: "cwd and filePath are required" });
  }
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const requested = realpathSync(filePath);
  const skill = loader.getSkills().skills.find((candidate) => {
    try {
      return realpathSync(candidate.filePath) === requested;
    } catch {
      return false;
    }
  });
  if (!skill) {
    throw new RpcError({ code: "FORBIDDEN", message: "Skill is not loaded for this project" });
  }
  return skill;
}

function writeTextAtomically(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

type ResourceHandlers = {
  toolchain: NonNullable<ApiHandler["host.toolchain"]>;
  getCacheWarming: NonNullable<ApiHandler["settings.getCacheWarming"]>;
  setCacheWarming: NonNullable<ApiHandler["settings.setCacheWarming"]>;
  listSkills: NonNullable<ApiHandler["skills.list"]>;
  searchSkills: NonNullable<ApiHandler["skills.search"]>;
  installSkill: NonNullable<ApiHandler["skills.install"]>;
  setSkill: NonNullable<ApiHandler["skills.set"]>;
  getSkillContent: NonNullable<ApiHandler["skills.getContent"]>;
  listPlugins: NonNullable<ApiHandler["plugins.list"]>;
  setPlugin: NonNullable<ApiHandler["plugins.set"]>;
};
export const resourceHandlers = {
  toolchain: async (params) => {
    const { cwd } = params as { cwd: string };
    if (!cwd || !path.isAbsolute(cwd)) throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
    const context = await toolchainRuntime.createExecutionContext({ cwd, intent: "project-command" });
    return {
      inventoryRevision: context.inventoryRevision,
      resolutionId: context.resolutionId,
      capabilities: Object.fromEntries(
        Object.entries(context.commands).map(([capability, command]) => [
          capability,
          { provider: command.provider, version: command.version },
        ]),
      ),
    };
  },

  getCacheWarming: async () => cacheWarmingSettings.get(),

  setCacheWarming: async (params) => {
    const mode = (params as { mode?: unknown } | undefined)?.mode;
    if (!isCacheWarmingMode(mode)) throw new RpcError({ code: "BAD_REQUEST", message: "Invalid cache warming mode" });
    try {
      return await cacheWarmingSettings.set(mode);
    } catch {
      throw new RpcError({ code: "INTERNAL", message: "Global Pi cache warming setting could not be saved" });
    }
  },

  listSkills: async (params) => {
    const cwd = (params as { cwd?: string } | void)?.cwd;
    if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    return { skills, diagnostics };
  },

  searchSkills: async (params) => {
    const { query } = params as { query: string };
    try {
      return (await searchSkills(query)) as never;
    } catch (e) {
      if (e instanceof ToolchainError) throw e;
      throw new RpcError({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  installSkill: async (params) => {
    try {
      return await installSkill(params as { package: string; scope?: "global" | "project"; cwd?: string });
    } catch (e) {
      if (e instanceof ToolchainError) throw e;
      throw new RpcError({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  setSkill: async (params) => {
    const body = params as {
      cwd: string;
      filePath: string;
      disableModelInvocation?: boolean;
      content?: string;
    };
    const skill = await resolveLoadedSkill(body.cwd, body.filePath);
    const { filePath } = skill;
    const content = body.content ?? readFileSync(filePath, "utf8");
    if (content.length > 2 * 1024 * 1024) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Skill file is too large" });
    }
    const updated =
      body.disableModelInvocation === undefined
        ? content
        : updateSkillModelInvocation(content, body.disableModelInvocation);
    writeTextAtomically(filePath, updated);
    return { ok: true as const };
  },

  getSkillContent: async (params) => {
    const body = params as { cwd: string; filePath: string };
    const skill = await resolveLoadedSkill(body.cwd, body.filePath);
    return { content: readFileSync(skill.filePath, "utf8") };
  },

  listPlugins: async (params) => {
    const cwd = (params as { cwd?: string } | void)?.cwd;
    if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
    return readPlugins(cwd);
  },

  setPlugin: async (params) => {
    return applyPluginAction(params);
  },
} satisfies ResourceHandlers;
