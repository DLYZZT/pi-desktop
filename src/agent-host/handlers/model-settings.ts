import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ApiHandler } from "../../contract/rpc";
import type { CatalogModel } from "../../contract/model-settings";
import { RpcError } from "../../contract/types";
import { createDesktopAgentSessionServices } from "../desktop-session-services";
import {
  readRoutingSettings,
  saveRoutingSettings,
  readAdvancedSettings,
  saveAdvancedSettings,
  validateRouting,
} from "../model-settings-store";

async function runtime(cwd?: string) {
  return (await createDesktopAgentSessionServices({ cwd: cwd || getAgentDir(), agentDir: getAgentDir() })).modelRuntime;
}

export function createModelSettingsHandlers(resolveRuntime: typeof runtime = runtime) {
  return {
    routingGet: async () => readRoutingSettings(),
    routingSet: async ({ config, expectedVersion, cwd }) => {
      validateRouting(config);
      if (config.enabled) {
        const models = await resolveRuntime(cwd);
        const available = await models.getAllAvailable();
        for (const [role, reference] of [
          ["fast", config.fast],
          ["strong", config.strong],
          ...(config.strategy === "classifier" ? [["classifier", config.classifier]] : []),
        ] as const) {
          const ref = reference as typeof config.fast;
          const type = role === "classifier" ? "classifier" : "chat";
          if (
            !ref ||
            !available.some(
              (model) =>
                model.provider === ref.provider &&
                model.id === ref.modelId &&
                (model.type ?? "chat") === type &&
                model.api !== "pi-virtual",
            )
          )
            throw new RpcError({
              code: "BAD_REQUEST",
              message: `The ${role} model is unavailable. Check its credentials and model type.`,
            });
        }
      }
      return saveRoutingSettings(config, expectedVersion);
    },
    advancedGet: async () => readAdvancedSettings(),
    advancedSet: async ({ config, expectedVersion }) => saveAdvancedSettings(config, expectedVersion),
    catalog: async (params) => {
      const models = await resolveRuntime(params?.cwd);
      const available = new Set(
        (await models.getAllAvailable()).map((model) =>
          JSON.stringify([model.provider, model.id, model.type ?? "chat"]),
        ),
      );
      const catalog: CatalogModel[] = models.getAllModels().map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        type: model.type ?? "chat",
        virtual: model.api === "pi-virtual",
        available: available.has(JSON.stringify([model.provider, model.id, model.type ?? "chat"])),
        thinkingLevels: (model.type ?? "chat") === "chat" ? getSupportedThinkingLevels(model as never) : [],
      }));
      return { models: catalog };
    },
    test: async ({ provider, modelId, type, cwd }) => {
      if (!["chat", "classifier", "image"].includes(type))
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid model type" });
      const models = await resolveRuntime(cwd);
      const model = models.getModelOfType(type, provider, modelId);
      if (!model || model.api === "pi-virtual") return { ok: false, error: "Select a physical catalog model" };
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      const options = { signal: controller.signal, timeoutMs: 60_000, maxRetries: 0 };
      try {
        if (type === "classifier") {
          const result = await models.classify(
            model as never,
            {
              state: { value: true },
              questions: {
                check: {
                  type: "bool",
                  instructions: "Is value true?",
                  criteria: { true: "The value in state is true", false: "The value in state is false" },
                },
              },
            },
            options,
          );
          return {
            ok: result.stopReason === "stop",
            latencyMs: Date.now() - started,
            responseText: JSON.stringify(result.answers),
            ...(result.stopReason !== "stop" ? { error: result.errorMessage ?? "Classification failed" } : {}),
          };
        }
        if (type === "image") {
          const result = await models.generateImages(
            model as never,
            { input: [{ type: "text", text: "A small solid blue circle on a white background." }] },
            options,
          );
          const count = result.output.filter((block) => block.type === "image").length;
          return {
            ok: result.stopReason === "stop" && count > 0,
            latencyMs: Date.now() - started,
            responseText: `${count} image(s)`,
            ...(result.stopReason !== "stop" || !count ? { error: result.errorMessage ?? "No image returned" } : {}),
          };
        }
        const result = await models.completeSimple(
          model as never,
          { messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] },
          { ...options, maxTokens: 16, cacheRetention: "none" },
        );
        return {
          ok: result.stopReason !== "error" && result.stopReason !== "aborted",
          latencyMs: Date.now() - started,
          responseText: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timeout);
      }
    },
  } satisfies {
    routingGet: NonNullable<ApiHandler["models.routing.get"]>;
    routingSet: NonNullable<ApiHandler["models.routing.set"]>;
    advancedGet: NonNullable<ApiHandler["settings.advanced.get"]>;
    advancedSet: NonNullable<ApiHandler["settings.advanced.set"]>;
    catalog: NonNullable<ApiHandler["models.catalog"]>;
    test: NonNullable<ApiHandler["models.test"]>;
  };
}

export const modelSettingsHandlers = createModelSettingsHandlers();
