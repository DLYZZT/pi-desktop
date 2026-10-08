import { createCodemodeExtension, type ExtensionFactory, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionExecutionHistory } from "./session-execution-history";

export interface CodemodeImageAccess {
  isAllowed(): boolean;
  history: SessionExecutionHistory;
}

/** Add Desktop policy and durable child records around the public Pi image API. */
export function createDesktopCodemodeExtension(access: CodemodeImageAccess): ExtensionFactory {
  return (pi) =>
    createCodemodeExtension({ models: true })({
      ...pi,
      registerTool: (definition) =>
        pi.registerTool({
          ...definition,
          promptGuidelines: [
            ...(definition.promptGuidelines ?? []),
            "In Pi Desktop, models supports image generation only. Discover authenticated image models with models.getAvailableOfType(\"image\"), call models.generateImages(model, {input}), then show every output image with image(block). Classification is unavailable. Image generation uses the session's Codemode permission and may consume the selected provider's paid usage.",
          ],
          execute: async (toolCallId, args, signal, onUpdate, ctx) => {
            let sequence = 0;
            const pending = new Set<Promise<unknown>>();
            const assertAllowed = () => {
              signal?.throwIfAborted();
              if (!access.isAllowed())
                throw new Error("TOOL_PERMISSION_DENIED: image generation requires Codemode permission");
            };
            const registry = ctx.modelRegistry;
            const generateImages: ModelRegistry["generateImages"] = (model, context, options) => {
              const callSignal = options?.signal;
              const event = {
                toolCallId: `${toolCallId}/desktop-image/${++sequence}`,
                parentToolCallId: toolCallId,
                toolName: "models.generateImages",
                args: { model: { provider: model.provider, id: model.id }, input: context.input },
              };
              const work = (async () => {
                await access.history.requested(event);
                try {
                  assertAllowed();
                  callSignal?.throwIfAborted();
                  await access.history.running(event);
                  // Recheck after persistence, immediately before provider credentials/network are used.
                  assertAllowed();
                  callSignal?.throwIfAborted();
                  const result = await registry.generateImages(model, context, options);
                  const { output, ...details } = result;
                  const errorText =
                    result.stopReason === "aborted"
                      ? `Image generation aborted: ${result.errorMessage ?? ""}`
                      : result.errorMessage;
                  await access.history.ended({
                    ...event,
                    isError: result.stopReason !== "stop",
                    result: {
                      content: [...output, ...(errorText ? [{ type: "text", text: errorText }] : [])],
                      details,
                      usage: result.usage,
                      isError: result.stopReason !== "stop",
                    },
                  });
                  return result;
                } catch (error) {
                  await access.history.ended({
                    ...event,
                    isError: true,
                    result: {
                      content: [
                        {
                          type: "text",
                          text: signal?.aborted || callSignal?.aborted ? "Image generation aborted" : String(error),
                        },
                      ],
                      isError: true,
                    },
                  });
                  throw error;
                }
              })();
              pending.add(work);
              void work.finally(() => pending.delete(work)).catch(() => {});
              return work;
            };
            const imageRegistry = new Proxy(registry, {
              get(target, property) {
                if (property === "generateImages") return generateImages;
                if (property === "classify")
                  return () => {
                    throw new Error("Classification is not enabled in Pi Desktop Codemode");
                  };
                if (property === "getModelsOfType")
                  return (type: string, provider?: string) => {
                    assertAllowed();
                    return type === "image" ? target.getModelsOfType("image", provider) : [];
                  };
                if (property === "getAvailableOfType")
                  return (
                    type: string,
                    provider?: string,
                    options?: Parameters<ModelRegistry["getAvailableOfType"]>[2],
                  ) => {
                    assertAllowed();
                    return type === "image"
                      ? target.getAvailableOfType("image", provider, options)
                      : Promise.resolve([]);
                  };
                if (property === "getModelOfType")
                  return (type: string, provider: string, id: string) => {
                    assertAllowed();
                    return type === "image" ? target.getModelOfType("image", provider, id) : undefined;
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            // Preserve prototype-backed context getters such as tools.
            const imageContext = new Proxy(ctx, {
              get(target, property) {
                if (property === "modelRegistry") return imageRegistry;
                // executeTool is an immutable own property; preserve its exact identity.
                return Reflect.get(target, property, target);
              },
            });
            try {
              return await definition.execute(toolCallId, args, signal, onUpdate, imageContext);
            } finally {
              // An aborted sandbox must not leave model calls writing history after session teardown.
              await Promise.allSettled(pending);
            }
          },
        }),
    });
}
