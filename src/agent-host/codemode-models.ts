import { createCodemodeExtension, type ExtensionFactory, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionExecutionHistory } from "./session-execution-history";

export interface CodemodeModelAccess {
  isAllowed(): boolean;
  history: SessionExecutionHistory;
}

type ModelResult =
  Awaited<ReturnType<ModelRegistry["generateImages"]>> | Awaited<ReturnType<ModelRegistry["classify"]>>;

/** Apply the same Desktop policy and durable history to image and classifier calls. */
export function createDesktopCodemodeExtension(access: CodemodeModelAccess): ExtensionFactory {
  return (pi) =>
    createCodemodeExtension({ models: true })({
      ...pi,
      registerTool: (definition) =>
        pi.registerTool({
          ...definition,
          promptGuidelines: [
            ...(definition.promptGuidelines ?? []),
            'In Pi Desktop, discover authenticated image models with models.getAvailableOfType("image") and decision models with models.getAvailableOfType("classifier"). Generate images with models.generateImages(model, {input}) and show them with image(block). Use models.classify(model, {state, questions, images?}) for choice, bool or score questions; check stopReason and return the answers needed by the task. Images require a classifier whose input includes "image". Model calls use the session\'s Codemode permission and their usage counts toward the session cost. Probabilities are model estimates; they do not grant permission to execute tools.',
          ],
          execute: async (toolCallId, args, signal, onUpdate, ctx) => {
            let sequence = 0;
            const pending = new Set<Promise<unknown>>();
            const assertAllowed = () => {
              signal?.throwIfAborted();
              if (!access.isAllowed())
                throw new Error("TOOL_PERMISSION_DENIED: model calls require Codemode permission");
            };
            const registry = ctx.modelRegistry;
            const track = <T extends ModelResult>(
              kind: "image" | "classifier",
              args: unknown,
              callSignal: AbortSignal | undefined,
              invoke: () => Promise<T>,
            ): Promise<T> => {
              const event = {
                toolCallId: `${toolCallId}/desktop-${kind}/${++sequence}`,
                parentToolCallId: toolCallId,
                toolName: kind === "image" ? "models.generateImages" : "models.classify",
                args,
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
                  const startedAt = performance.now();
                  const result = await invoke();
                  const durationMs = Math.round(performance.now() - startedAt);
                  const { output, ...details } =
                    "output" in result
                      ? result
                      : { ...result, output: [{ type: "text" as const, text: JSON.stringify(result.answers) }] };
                  const errorText =
                    result.stopReason === "aborted"
                      ? `Model call aborted: ${result.errorMessage ?? ""}`
                      : result.stopReason === "error"
                        ? result.errorMessage || "Model call failed"
                        : undefined;
                  await access.history.ended({
                    ...event,
                    durationMs,
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
                          text: signal?.aborted || callSignal?.aborted ? "Model call aborted" : String(error),
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
            const operationSignal = (callSignal?: AbortSignal) =>
              signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
            const generateImages: ModelRegistry["generateImages"] = (model, context, options) => {
              const callSignal = operationSignal(options?.signal);
              return track(
                "image",
                { model: { provider: model.provider, id: model.id }, input: context.input },
                callSignal,
                () => registry.generateImages(model, context, { ...options, signal: callSignal }),
              );
            };
            const classify: ModelRegistry["classify"] = (model, context, options) => {
              const callSignal = operationSignal(options?.signal);
              return track(
                "classifier",
                { ...context, model: { provider: model.provider, id: model.id } },
                callSignal,
                () => registry.classify(model, context, { ...options, signal: callSignal }),
              );
            };
            const modelRegistry = new Proxy(registry, {
              get(target, property) {
                if (property === "generateImages") return generateImages;
                if (property === "classify") return classify;
                if (property === "getModelsOfType")
                  return (type: string, provider?: string) => {
                    assertAllowed();
                    return type === "image" || type === "classifier" ? target.getModelsOfType(type, provider) : [];
                  };
                if (property === "getAvailableOfType")
                  return (
                    type: string,
                    provider?: string,
                    options?: Parameters<ModelRegistry["getAvailableOfType"]>[2],
                  ) => {
                    assertAllowed();
                    return type === "image" || type === "classifier"
                      ? target.getAvailableOfType(type, provider, options)
                      : Promise.resolve([]);
                  };
                if (property === "getModelOfType")
                  return (type: string, provider: string, id: string) => {
                    assertAllowed();
                    return type === "image" || type === "classifier"
                      ? target.getModelOfType(type, provider, id)
                      : undefined;
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            // Preserve prototype-backed context getters such as tools.
            const modelContext = new Proxy(ctx, {
              get(target, property) {
                if (property === "modelRegistry") return modelRegistry;
                // executeTool is an immutable own property; preserve its exact identity.
                return Reflect.get(target, property, target);
              },
            });
            try {
              return await definition.execute(toolCallId, args, signal, onUpdate, modelContext);
            } finally {
              // An aborted sandbox must not leave model calls writing history after session teardown.
              while (pending.size) await Promise.allSettled([...pending]);
            }
          },
        }),
    });
}
