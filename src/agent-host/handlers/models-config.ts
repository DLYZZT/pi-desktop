import { validateModelEditorConfig } from "../model-editor-validation";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createDesktopModelRuntime } from "../model-credentials";
import { probeChatModel } from "../model-chat-probe";
import { discoverProviderModels } from "../model-discovery";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { reloadSharedModelRuntimeConfig } from "../model-runtime";
import { ensureAzureUpgrade } from "../azure-upgrade";
import { withLockedJsonFile } from "../../shared/node/locked-json-file";
import { inspectModelsConfig, inspectModelsConfigCompatibility, parseModelsConfig } from "../models-config-validation";
import { ensureProviderRenameSettings, withProviderRenames } from "../provider-renames";

function getModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

type ModelsFileSnapshot = { raw: string | null; version: string };

function modelsContentVersion(raw: string | null): string {
  return raw === null ? "missing" : `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function readModelsFileSnapshot(): ModelsFileSnapshot {
  const p = getModelsPath();
  if (!existsSync(p)) return { raw: null, version: modelsContentVersion(null) };
  const raw = readFileSync(p, "utf8");
  return { raw, version: modelsContentVersion(raw) };
}

function readModelsJsonSnapshot(): { config: Record<string, unknown>; version: string } {
  const snapshot = readModelsFileSnapshot();
  if (snapshot.raw === null) return { config: { providers: {} }, version: snapshot.version };
  try {
    return { config: parseModelsConfig(snapshot.raw), version: snapshot.version };
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "models.json contains invalid JSON",
    });
  }
}

function modelsConfigConflict(expectedVersion: string, currentVersion: string): RpcError {
  return new RpcError({
    code: "CONFLICT",
    message: "models.json changed outside this editor; current edits were not saved",
    detail: { expectedVersion, currentVersion },
  });
}

async function writeModelsJson(
  data: Record<string, unknown>,
  expectedVersion: string,
  providerRenames?: unknown,
): Promise<string> {
  const p = getModelsPath();
  return withLockedJsonFile(
    p,
    async () => {
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const initial = readModelsFileSnapshot();
      if (initial.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, initial.version);
      // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
      const tmp = `${p}.${process.pid}.tmp`;
      const bak = `${p}.bak`;
      const serialized = JSON.stringify(
        withProviderRenames(
          initial.raw === null ? { providers: {} } : parseModelsConfig(initial.raw),
          data,
          providerRenames,
        ),
        null,
        2,
      );
      writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
      try {
        const beforeCommit = readModelsFileSnapshot();
        if (beforeCommit.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, beforeCommit.version);
        if (beforeCommit.raw !== null) {
          try {
            writeFileSync(bak, beforeCommit.raw, { encoding: "utf8", mode: 0o600 });
            if (process.platform !== "win32") chmodSync(bak, 0o600);
          } catch {
            /* ignore bak failure */
          }
        }
        renameSync(tmp, p);
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
      return modelsContentVersion(serialized);
    },
    undefined,
    { parse: parseModelsConfig },
  );
}

function compatibilityWarnings(config: unknown) {
  const warnings = inspectModelsConfigCompatibility(config);
  return warnings.length ? { warnings } : {};
}

type ModelConfigHandlers = {
  get: NonNullable<ApiHandler["modelsConfig.get"]>;
  set: NonNullable<ApiHandler["modelsConfig.set"]>;
  test: NonNullable<ApiHandler["modelsConfig.test"]>;
  discover: NonNullable<ApiHandler["modelsConfig.discover"]>;
};

export const modelConfigHandlers = {
  discover: async (params) => discoverProviderModels(params?.provider),
  get: async () => {
    // Inspect before migrations. An invalid SDK configuration must remain editable and byte-for-byte intact.
    const original = readModelsJsonSnapshot();
    const issues = inspectModelsConfig(original.config);
    if (issues.length) return { ...original, issues, ...compatibilityWarnings(original.config) };
    const azureUpgrade = await ensureAzureUpgrade();
    const snapshot = readModelsJsonSnapshot();
    const currentIssues = inspectModelsConfig(snapshot.config);
    return {
      ...snapshot,
      azureUpgrade,
      ...(currentIssues.length ? { issues: currentIssues } : {}),
      ...compatibilityWarnings(snapshot.config),
    };
  },

  set: async (params) => {
    const body = params as { config?: unknown; expectedVersion?: unknown; providerRenames?: unknown };
    const config = body?.config as Record<string, unknown> | undefined;
    // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
    if (!config || typeof config !== "object" || !("providers" in config)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
    }
    if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
      throw new RpcError({ code: "BAD_REQUEST", message: "expectedVersion is required" });
    }
    validateModelEditorConfig(config);
    // Editor removals use undefined; validate exactly the JSON that will be persisted, not those sentinels.
    const persisted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    const issues = inspectModelsConfig(persisted);
    if (issues.length)
      throw new RpcError({
        code: "BAD_REQUEST",
        message: `Invalid model configuration; no changes were saved: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        detail: { issues },
      });
    const version = await writeModelsJson(persisted, body.expectedVersion, body.providerRenames);
    // Migrate global references now, before other writers can make the settings look newer than the rename.
    if (body.providerRenames !== undefined) await ensureProviderRenameSettings();
    await reloadSharedModelRuntimeConfig();
    return { ok: true as const, version, ...compatibilityWarnings(persisted) };
  },

  test: async (params) => {
    const body = params;
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return { ok: false, error: "providerName is required" };
    if (!body.provider || typeof body.provider !== "object") {
      return { ok: false, error: "provider is required" };
    }
    if (!body.model || typeof body.model !== "object") {
      return { ok: false, error: "model is required" };
    }
    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return { ok: false, error: "Model ID is required" };

    let tempDir: string | undefined;
    try {
      tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-test-"));
      const modelsPath = path.join(tempDir, "models.json");
      writeFileSync(
        modelsPath,
        JSON.stringify(
          {
            providers: {
              [providerName]: {
                ...body.provider,
                models: [{ ...body.model, id: modelId }],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const modelRuntime = await createDesktopModelRuntime({ modelsPath, allowModelNetwork: false });
      const loadError = modelRuntime.getError();
      if (loadError) return { ok: false, error: loadError };

      const model = modelRuntime.getModel(providerName, modelId);
      if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

      const auth = await modelRuntime.getAuth(model);
      if (!auth) return { ok: false, error: `No authentication found for "${providerName}"` };

      return await probeChatModel(modelRuntime, model, 20_000);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  },
} satisfies ModelConfigHandlers;
