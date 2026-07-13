/**
 * OAuth login progress service for Streams["auth.login"].
 */
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";

type Pending = {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};

const loginCallbacks = new Map<string, Pending>();
const activeLogins = new Map<string, AbortController>();

export function resolveLoginCode(token: string, code: string): boolean {
  const pending = loginCallbacks.get(token);
  if (!pending) return false;
  pending.resolve(code);
  loginCallbacks.delete(token);
  return true;
}

export function cancelLogin(provider: string): void {
  const abort = activeLogins.get(provider);
  if (abort) {
    abort.abort();
    activeLogins.delete(provider);
  }
  for (const [token, pending] of [...loginCallbacks.entries()]) {
    if (token.startsWith(`${provider}-`)) {
      pending.reject(new Error("Login cancelled"));
      loginCallbacks.delete(token);
    }
  }
}

type AuthStorageFactory = () => Pick<AuthStorage, "getOAuthProviders" | "login">;

export function createAuthLoginService(
  server: RpcServer,
  createAuthStorage: AuthStorageFactory = () => AuthStorage.create(),
) {
  function emit(provider: string, data: Record<string, unknown>) {
    server.emit("auth.login", provider, data as never);
  }

  return {
    async start(provider: string): Promise<{ started: boolean }> {
      if (activeLogins.has(provider)) {
        return { started: false };
      }

      const authStorage = createAuthStorage();
      const providers = authStorage.getOAuthProviders();
      const providerInfo = providers.find((p) => p.id === provider);
      if (!providerInfo) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown provider: ${provider}` });
      }

      const abort = new AbortController();
      activeLogins.set(provider, abort);
      const activeTokens = new Set<string>();

      const createClientInputRequest = () => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);
        const promise = new Promise<string>((resolve, reject) => {
          loginCallbacks.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              loginCallbacks.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              loginCallbacks.delete(token);
              reject(error);
            },
          });
        });
        return { token, promise };
      };

      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;
      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      const cleanup = () => {
        for (const token of activeTokens) {
          loginCallbacks.get(token)?.reject(new Error("Login cancelled"));
          loginCallbacks.delete(token);
        }
        activeTokens.clear();
        // A cancelled flow may finish after its replacement has started.
        // Only remove this flow's own controller from the provider slot.
        if (activeLogins.get(provider) === abort) {
          activeLogins.delete(provider);
        }
      };

      abort.signal.addEventListener("abort", cleanup);

      // Fire-and-forget; stream progress via auth.login
      void (async () => {
        try {
          await authStorage.login(provider, {
            onAuth: (info: { url: string; instructions?: string }) => {
              const request = getManualInputRequest();
              emit(provider, {
                type: "auth",
                url: info.url,
                instructions: info.instructions ?? null,
                token: request.token,
              });
            },
            onDeviceCode: (info: {
              userCode: string;
              verificationUri: string;
              intervalSeconds?: number;
              expiresInSeconds?: number;
            }) => {
              emit(provider, {
                type: "device_code",
                userCode: info.userCode,
                verificationUri: info.verificationUri,
                intervalSeconds: info.intervalSeconds ?? null,
                expiresInSeconds: info.expiresInSeconds ?? null,
              });
            },
            onPrompt: async (prompt: { message: string; placeholder?: string }) => {
              const request = getManualInputRequest();
              emit(provider, {
                type: "prompt_request",
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                token: request.token,
              });
              return request.promise;
            },
            onProgress: (message: string) => {
              emit(provider, { type: "progress", message });
            },
            onSelect: async (prompt: { message: string; options: { id: string; label: string }[] }) => {
              const request = createClientInputRequest();
              emit(provider, {
                type: "select_request",
                message: prompt.message,
                options: prompt.options,
                token: request.token,
              });
              const value = await request.promise;
              return value || undefined;
            },
            onManualCodeInput: () => getManualInputRequest().promise,
            signal: abort.signal,
          } as never);

          emit(provider, { type: "success" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "Login cancelled" || abort.signal.aborted) {
            emit(provider, { type: "cancelled" });
          } else {
            emit(provider, { type: "error", message: msg });
          }
        } finally {
          cleanup();
        }
      })();

      return { started: true };
    },

    cancel(provider: string) {
      cancelLogin(provider);
    },
  };
}
