import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError, type ApiKeyProviderStatus } from "../../contract/types";
import { getSharedModelRuntime } from "../model-runtime";
import { credentialStateMatches, recoverCommittedCredential, type CredentialTarget } from "../credential-sync";
import { resolveLoginCode, type createAuthLoginService } from "../auth-login";

export async function credentialMutationFailure(
  modelRuntime: ModelRuntime,
  providerId: string,
  target: CredentialTarget,
  error: unknown,
) {
  if (error instanceof CredentialSynchronizationError) {
    const recovered = await recoverCommittedCredential(modelRuntime, providerId, target);
    if (recovered) {
      if (!recovered.synchronized) {
        console.warn(`[agent-host] credential ${error.operation} committed for ${providerId}; model sync retry failed`);
      }
      return recovered;
    }
    throw new RpcError({ code: "INTERNAL", message: `Credential change for ${providerId} could not be verified` });
  }
  throw new RpcError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
}

type AuthHandlers = {
  providers: NonNullable<ApiHandler["auth.providers"]>;
  allProviders: NonNullable<ApiHandler["auth.allProviders"]>;
  setApiKey: NonNullable<ApiHandler["auth.setApiKey"]>;
  deleteApiKey: NonNullable<ApiHandler["auth.deleteApiKey"]>;
  logout: NonNullable<ApiHandler["auth.logout"]>;
  submitLogin: NonNullable<ApiHandler["auth.loginSubmit"]>;
  startLogin: NonNullable<ApiHandler["auth.loginStart"]>;
  cancelLogin: NonNullable<ApiHandler["auth.loginCancel"]>;
};

/** Login service creation and ownership remain with registerHandlers. */
export function createAuthHandlers(authLogin: Pick<ReturnType<typeof createAuthLoginService>, "start" | "cancel">) {
  return {
    providers: async () => {
      const modelRuntime = await getSharedModelRuntime();
      const storedProviders = new Set(
        (await modelRuntime.listCredentials())
          .filter((entry) => entry.type === "oauth")
          .map((entry) => entry.providerId),
      );
      const EXCLUDED = new Set(["anthropic"]);
      const DISPLAY_NAMES: Record<string, string> = {
        "openai-codex": "ChatGPT Plus/Pro",
        "github-copilot": "GitHub Copilot",
      };
      const result = modelRuntime
        .getProviders()
        .filter((p) => p.auth.oauth && !EXCLUDED.has(p.id))
        .map((p) => ({
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: false,
          authenticated: storedProviders.has(p.id),
          loggedIn: storedProviders.has(p.id),
        }));
      return { providers: result };
    },

    allProviders: async () => {
      const modelRuntime = await getSharedModelRuntime();
      const all = modelRuntime.getModels();
      const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);
      const seen = new Set<string>();
      const result: ApiKeyProviderStatus[] = [];
      for (const model of all) {
        if (seen.has(model.provider)) continue;
        seen.add(model.provider);
        if (OAUTH_PROVIDER_IDS.has(model.provider)) continue;
        const provider = modelRuntime.getProvider(model.provider);
        if (!provider?.auth.apiKey) continue;
        const status = modelRuntime.getProviderAuthStatus(model.provider);
        if (status.source === "models_json_key") continue;
        result.push({
          id: model.provider,
          displayName: provider.name,
          configured: status.configured,
          source: status.label ?? status.source,
          modelCount: all.filter((candidate) => candidate.provider === model.provider).length,
        });
      }
      return { providers: result };
    },

    setApiKey: async (params) => {
      const { provider, key } = params as { provider: string; key: string };
      if (!provider || !key?.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "provider and key required" });
      }
      const modelRuntime = await getSharedModelRuntime();
      let promptCount = 0;
      const interaction: AuthInteraction = {
        async prompt(request) {
          promptCount += 1;
          if (promptCount !== 1 || request.type !== "secret") {
            throw new Error(`${provider} requires an interactive, multi-field login flow`);
          }
          return key.trim();
        },
        notify() {},
      };
      try {
        await modelRuntime.login(provider, "api_key", interaction);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: true, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: true, type: "api_key" }))) {
        throw new RpcError({
          code: "INTERNAL",
          message: `Key for ${provider} was written but not readable back`,
        });
      }
      return { ok: true as const, synchronized: true };
    },

    deleteApiKey: async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false, type: "api_key" }))) {
        throw new RpcError({ code: "INTERNAL", message: `Key removal for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    logout: async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false }))) {
        throw new RpcError({ code: "INTERNAL", message: `Logout for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    submitLogin: async (params) => {
      const { provider, token, code } = params as {
        provider: string;
        token: string;
        code: string;
      };
      if (!resolveLoginCode(provider, token, code)) {
        throw new RpcError({ code: "NOT_FOUND", message: "No pending login for token" });
      }
      return { ok: true as const };
    },

    startLogin: async (params) => {
      const { provider } = params as { provider: string };
      const result = await authLogin.start(provider);
      return { ok: true as const, started: result.started };
    },

    cancelLogin: async (params) => {
      const { provider } = params as { provider: string };
      authLogin.cancel(provider);
      return { ok: true as const };
    },
  } satisfies AuthHandlers;
}
