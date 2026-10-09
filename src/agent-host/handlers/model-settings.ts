import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ApiHandler } from "../../contract/rpc";
import type { CatalogModel } from "../../contract/model-settings";
import { RpcError } from "../../contract/types";
import { createDesktopAgentSessionServices } from "../desktop-session-services";
import { probeChatModel } from "../model-chat-probe";
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
        const roles: ("fast" | "strong" | "classifier")[] = ["fast", "strong"];
        if (config.strategy === "classifier") roles.push("classifier");
        for (const role of roles) {
          const ref = config[role];
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
      const key = (model: { provider: string; id: string; type?: CatalogModel["type"] }) =>
        JSON.stringify([model.provider, model.id, model.type ?? "chat"]);
      const available = new Set((await models.getAllAvailable()).map(key));
      const catalog: CatalogModel[] = models.getAllModels().map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        type: model.type ?? "chat",
        virtual: model.api === "pi-virtual",
        available: available.has(key(model)),
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
      const options = { signal: AbortSignal.timeout(60_000), timeoutMs: 60_000, maxRetries: 0 };
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
        return await probeChatModel(models, model as never, 60_000);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
