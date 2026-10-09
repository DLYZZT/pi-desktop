import type { Usage, ClassifierResult } from "@earendil-works/pi-ai";
import type { InlineExtension, ModelRouteRequest, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import type { AutoRoutingConfig, ModelReference } from "../contract/model-settings";
import { AUTO_ROUTING_MODEL, AUTO_ROUTING_PROVIDER } from "../contract/model-settings";
import { readRoutingSettings } from "./model-settings-store";

type UsageRecorder = (provider: string, model: string, usage: Usage) => void;

type RouteState = { target: ModelReference; reason: string };

export async function routeDesktopModel(
  config: AutoRoutingConfig,
  request: ModelRouteRequest<RouteState>,
  ctx: ExtensionContext,
  recordUsage: UsageRecorder,
): Promise<ModelRoute<RouteState>> {
  request.signal?.throwIfAborted();
  const choose = (reference: ModelReference | undefined, reason: string): ModelRoute<RouteState> => {
    const model = reference && ctx.modelRegistry.find(reference.provider, reference.modelId);
    if (!model || model.api === "pi-virtual")
      throw new Error("Auto requires an available physical model. Review Auto routing settings.");
    const strong = reference?.provider === config.strong?.provider && reference?.modelId === config.strong?.modelId;
    return {
      model,
      thinkingLevel: (strong ? config.strongThinking : config.fastThinking) as ModelRoute["thinkingLevel"],
      state: { target: reference!, reason },
    };
  };
  if (request.reason === "retry" && request.failed && config.retryFallback) {
    const failed = request.failed.model;
    const wasStrong = failed.provider === config.strong?.provider && failed.id === config.strong?.modelId;
    return choose(wasStrong ? config.fast : config.strong, "retry");
  }
  const sticky = request.failed ?? request.previous;
  if (request.reason !== "user" && sticky)
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel, state: request.state };
  if (request.reason === "direct") return choose(config.strong, "summary");
  if (config.strategy === "thinking")
    return choose(["high", "xhigh", "max"].includes(request.thinkingLevel) ? config.strong : config.fast, "thinking");
  const classifier =
    config.classifier &&
    ctx.modelRegistry.findOfType("classifier", config.classifier.provider, config.classifier.modelId);
  if (!classifier) return choose(config.strong, "classifier-unavailable");
  let result: ClassifierResult;
  try {
    const user = request.messages.filter((message) => message.role === "user").at(-1);
    const text =
      typeof user?.content === "string"
        ? user.content
        : (user?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ?? "");
    result = await ctx.modelRegistry.classify(
      classifier,
      {
        state: { prompt: text.slice(0, 32_000) },
        questions: {
          complexity: {
            type: "choice",
            instructions:
              "Classify the difficulty of the user's request. Choose complex for ambiguity, multi-file changes, architecture, or difficult debugging.",
            criteria: {
              simple: "Routine explanation or a small well-defined edit",
              complex: "Demanding analysis, planning, implementation, or debugging",
            },
          },
        },
      },
      { signal: request.signal, timeoutMs: 15_000, maxRetries: 0 },
    );
  } catch {
    request.signal?.throwIfAborted();
    return choose(config.strong, "classifier-error");
  }
  // Accounting failures are fatal: never hide a paid request whose usage could not be saved.
  if (result.usage) recordUsage(classifier.provider, classifier.id, result.usage);
  request.signal?.throwIfAborted();
  const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
  if (answer?.type !== "choice") return choose(config.strong, "classifier-error");
  const probability = answer.probabilities.complex;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    return choose(config.strong, "classifier-error");
  const complex = probability >= 0.5;
  return choose(complex ? config.strong : config.fast, complex ? "complex" : "simple");
}

export function createAutoRoutingExtension(
  agentDir: string,
  recordUsage: UsageRecorder = () => {
    throw new Error("Auto routing usage recorder is unavailable");
  },
): InlineExtension {
  return {
    name: "pi-desktop:auto-routing",
    hidden: true,
    factory(pi) {
      const { config } = readRoutingSettings(agentDir);
      if (!config.enabled) return;
      pi.registerVirtualModel<RouteState>({
        provider: AUTO_ROUTING_PROVIDER,
        id: AUTO_ROUTING_MODEL,
        name: "Auto",
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        route: (request, ctx) => routeDesktopModel(config, request, ctx, recordUsage),
      });
    },
  };
}
