/**
 * OAuth login progress service for Streams["auth.login"].
 */
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";
import { getSharedModelRuntime } from "./model-runtime";

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

type OAuthRuntime = {
  getProvider(provider: string): { auth: { oauth?: unknown } } | undefined;
  login(provider: string, type: "oauth", interaction: AuthInteraction): Promise<unknown>;
};

type ModelRuntimeFactory = () => OAuthRuntime | Promise<OAuthRuntime>;

export function createAuthLoginService(
  server: RpcServer,
  createModelRuntime: ModelRuntimeFactory = getSharedModelRuntime,
) {
  function emit(provider: string, data: Record<string, unknown>) {
    server.emit("auth.login", provider, data as never);
  }

  return {
    async start(provider: string): Promise<{ started: boolean }> {
      if (activeLogins.has(provider)) {
        return { started: false };
      }

      const modelRuntime = await createModelRuntime();
      const providerInfo = modelRuntime.getProvider(provider);
      if (!providerInfo?.auth.oauth) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown provider: ${provider}` });
      }

      const abort = new AbortController();
      activeLogins.set(provider, abort);
      const activeTokens = new Set<string>();

      const createClientInputRequest = (signal?: AbortSignal) => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);
        const promise = new Promise<string>((resolve, reject) => {
          let removeAbortListener = () => {};
          const pending: Pending = {
            resolve: (value) => {
              activeTokens.delete(token);
              loginCallbacks.delete(token);
              removeAbortListener();
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              loginCallbacks.delete(token);
              removeAbortListener();
              reject(error);
            },
          };
          loginCallbacks.set(token, pending);
          if (signal) {
            const onAbort = () => pending.reject(new Error("Prompt cancelled"));
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        return { token, promise };
      };

      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;
      const getManualInputRequest = (signal?: AbortSignal) => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest(signal);
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

      const notify = (event: AuthEvent) => {
        switch (event.type) {
          case "auth_url": {
            const request = getManualInputRequest();
            emit(provider, {
              type: "auth",
              url: event.url,
              instructions: event.instructions ?? null,
              token: request.token,
            });
            break;
          }
          case "device_code":
            emit(provider, {
              type: "device_code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds ?? null,
              expiresInSeconds: event.expiresInSeconds ?? null,
            });
            break;
          case "progress":
            emit(provider, { type: "progress", message: event.message });
            break;
          case "info":
            emit(provider, { type: "progress", message: event.message, links: event.links ?? [] });
            break;
        }
      };

      const prompt = async (request: AuthPrompt): Promise<string> => {
        if (request.type === "select") {
          const pending = createClientInputRequest(request.signal);
          emit(provider, {
            type: "select_request",
            message: request.message,
            options: request.options.map(({ id, label }) => ({ id, label })),
            token: pending.token,
          });
          return pending.promise;
        }

        const pending =
          request.type === "manual_code"
            ? getManualInputRequest(request.signal)
            : createClientInputRequest(request.signal);
        emit(provider, {
          type: "prompt_request",
          message: request.message,
          placeholder: request.placeholder ?? null,
          token: pending.token,
          secret: request.type === "secret",
        });
        return pending.promise;
      };

      // Fire-and-forget; stream progress via auth.login
      void (async () => {
        try {
          await modelRuntime.login(provider, "oauth", {
            signal: abort.signal,
            notify,
            prompt,
          });

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
