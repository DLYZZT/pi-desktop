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
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { reloadSharedModelRuntimeConfig } from "../model-runtime";
import { ensureAzureUpgrade } from "../azure-upgrade";
import { withLockedJsonFile } from "../../shared/node/locked-json-file";

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
    return { config: JSON.parse(snapshot.raw) as Record<string, unknown>, version: snapshot.version };
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse models.json: ${e instanceof Error ? e.message : String(e)}`,
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

async function writeModelsJson(data: Record<string, unknown>, expectedVersion: string): Promise<string> {
  const p = getModelsPath();
  return withLockedJsonFile(p, async () => {
    mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const initial = readModelsFileSnapshot();
    if (initial.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, initial.version);
    // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
    const tmp = `${p}.${process.pid}.tmp`;
    const bak = `${p}.bak`;
    const serialized = JSON.stringify(data, null, 2);
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
  });
}

type ModelConfigHandlers = {
  get: NonNullable<ApiHandler["modelsConfig.get"]>;
  set: NonNullable<ApiHandler["modelsConfig.set"]>;
  test: NonNullable<ApiHandler["modelsConfig.test"]>;
};

export const modelConfigHandlers = {
  get: async () => {
    const azureUpgrade = await ensureAzureUpgrade();
    return { ...readModelsJsonSnapshot(), azureUpgrade };
  },

  set: async (params) => {
    const body = params as { config?: unknown; expectedVersion?: unknown };
    const config = body?.config as Record<string, unknown> | undefined;
    // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
    if (!config || typeof config !== "object" || !("providers" in config)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
    }
    if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
      throw new RpcError({ code: "BAD_REQUEST", message: "expectedVersion is required" });
    }
    const version = await writeModelsJson(config, body.expectedVersion);
    await reloadSharedModelRuntimeConfig();
    return { ok: true as const, version };
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

      const TEST_TIMEOUT_MS = 20_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
      let status: number | undefined;
      const startedAt = Date.now();
      try {
        const message = await modelRuntime.completeSimple(
          model,
          {
            messages: [
              {
                role: "user",
                content: "Reply with OK only.",
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: 16,
            timeoutMs: TEST_TIMEOUT_MS,
            maxRetries: 0,
            cacheRetention: "none",
            signal: controller.signal,
            onResponse: (response: { status: number }) => {
              status = response.status;
            },
          },
        );

        const latencyMs = Date.now() - startedAt;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return {
            ok: false,
            error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
            latencyMs,
            status,
          };
        }
        const responseText = message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("")
          .slice(0, 300);
        return { ok: true, latencyMs, status, responseText };
      } finally {
        clearTimeout(timeout);
      }
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
