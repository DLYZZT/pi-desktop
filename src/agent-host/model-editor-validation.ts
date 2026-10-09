import { RpcError } from "../contract/types";
import { THINKING_LEVELS } from "../shared/thinking-levels";

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError({ code: "BAD_REQUEST", message: `${field} must be an object` });
  return value as Record<string, unknown>;
}

/** Validate editable model parameters without rejecting or dropping opaque legacy/provider fields. */
export function validateModelEditorConfig(config: Record<string, unknown>): void {
  function modelParameters(value: unknown) {
    const model = object(value, "Model parameters");
    for (const field of ["contextWindow", "maxTokens"]) {
      if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || (model[field] as number) <= 0))
        throw new RpcError({ code: "BAD_REQUEST", message: `${field} must be a positive safe integer` });
    }
    if (model.samplingParams !== undefined) object(model.samplingParams, "samplingParams");
    if (model.samplingParamsByThinkingLevel !== undefined) {
      for (const [level, parameters] of Object.entries(
        object(model.samplingParamsByThinkingLevel, "samplingParamsByThinkingLevel"),
      )) {
        if (!THINKING_LEVELS.includes(level as never))
          throw new RpcError({ code: "BAD_REQUEST", message: `Unknown thinking level: ${level}` });
        object(parameters, `samplingParamsByThinkingLevel.${level}`);
      }
    }
    if (model.inputLimits !== undefined) {
      const limits = object(model.inputLimits, "inputLimits");
      if (limits.images !== undefined) object(limits.images, "inputLimits.images");
    }
  }
  for (const value of Object.values(object(config.providers, "providers"))) {
    const provider = object(value, "Provider");
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models))
        throw new RpcError({ code: "BAD_REQUEST", message: "models must be an array" });
      for (const model of provider.models) modelParameters(model);
    }
    if (provider.modelOverrides !== undefined)
      for (const override of Object.values(object(provider.modelOverrides, "modelOverrides")))
        modelParameters(override);
  }
}
