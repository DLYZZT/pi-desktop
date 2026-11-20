import { Type, type TSchema } from "typebox";

const DESCRIPTION_PROMPT =
  "Briefly describe the command's purpose in the user's language; do not repeat the command or claim success.";

/** Add an optional model-facing purpose summary without changing shell execution. */
export function withShellToolDescriptionParameter<T extends { parameters: TSchema }>(definition: T): T {
  if (!Type.IsObject(definition.parameters)) {
    throw new TypeError("Shell tool parameters must be an object schema");
  }

  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...definition.parameters.properties,
        description: Type.Optional(Type.String({ description: DESCRIPTION_PROMPT })),
      },
    },
  } as T;
}
