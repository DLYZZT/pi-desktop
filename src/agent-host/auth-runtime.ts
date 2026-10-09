import type { AuthInteraction, LoginOptions } from "@earendil-works/pi-ai";
import type { CredentialMutationOptions } from "../contract/auth";
import { RpcError } from "../contract/types";
import { getSharedModelRuntime } from "./model-runtime";
import { getCredentialMutations } from "./credential-mutations";

/** Native auth returns a credential; Desktop commits it with a version/type guard. */
export async function createGuardedOAuthRuntime() {
  const runtime = await getSharedModelRuntime();
  return {
    getProvider: runtime.getProvider.bind(runtime),
    listCredentials: runtime.listCredentials.bind(runtime),
    refresh: runtime.refresh.bind(runtime),
    async login(
      provider: string,
      type: "oauth" | "api_key",
      interaction: AuthInteraction,
      options?: LoginOptions,
      mutation?: CredentialMutationOptions,
    ) {
      if (
        type === "oauth" &&
        provider === "openai" &&
        runtime.getModels(provider).some((model) => model.baseUrl !== "https://api.openai.com/v1")
      ) {
        throw new RpcError({
          code: "BAD_REQUEST",
          message:
            "ChatGPT subscription login requires the default OpenAI endpoint. Use a separate provider for custom gateways.",
        });
      }
      return getCredentialMutations().login(runtime, provider, type, interaction, options, mutation);
    },
  };
}
