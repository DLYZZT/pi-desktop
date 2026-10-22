import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DiscoveredModel, ModelDiscoveryResult } from "../contract/types.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function discoveryEndpoints(value: unknown): URL[] {
  if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS Base URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP or HTTPS Base URL without credentials, query parameters, or a fragment");
  const base = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "");
  url.pathname = `${base}/models`;
  return base ? [url] : [url, new URL("/v1/models", url)];
}

/** Use the SDK's credential expressions without saving the draft or reading unrelated credentials. */
async function discoveryHeaders(provider: Record<string, unknown>): Promise<Headers> {
  const configuredHeaders: Record<string, string> = {};
  if (provider.headers !== undefined) {
    if (!provider.headers || typeof provider.headers !== "object" || Array.isArray(provider.headers))
      throw new Error("Provider headers must be an object");
    for (const [key, value] of Object.entries(provider.headers)) {
      if (value === null) continue;
      if (typeof value !== "string") throw new Error("Provider header values must be strings");
      configuredHeaders[key] = value;
    }
  }
  if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") throw new Error("API key must be a string");
  try {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => {
          throw new Error("Discovery cannot write credentials");
        },
        delete: async () => {
          throw new Error("Discovery cannot delete credentials");
        },
      },
    });
    const id = "desktop-model-discovery";
    runtime.registerProvider(id, {
      api: "openai-completions",
      apiKey: (provider.apiKey as string | undefined) ?? "",
      headers: configuredHeaders,
    });
    const result = await runtime.getAuth(id);
    const headers = new Headers({ Accept: "application/json" });
    for (const [key, value] of Object.entries(result?.auth.headers ?? {})) {
      if (value != null) headers.set(key, value);
    }
    if (result?.auth.apiKey && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${result.auth.apiKey}`);
    return headers;
  } catch {
    // Resolver errors can include shell commands or credential expressions.
    throw new Error("Could not resolve the API key or headers. Check the configured credential sources.");
  }
}

async function readModels(response: Response): Promise<DiscoveredModel[]> {
  if (!response.body) throw new Error("The models endpoint returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("The models response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The models endpoint did not return valid JSON");
  }
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
  if (!Array.isArray(data)) throw new Error('Expected an OpenAI-compatible model list with a "data" array');
  const models = new Map<string, DiscoveredModel>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) continue;
    const id = entry.id.trim();
    if (!models.has(id))
      models.set(id, {
        id,
        ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}),
      });
  }
  if (data.length && !models.size) throw new Error("The models response contains no valid model IDs");
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Discover IDs only: a /models listing does not establish reasoning, context, or pricing capabilities. */
export async function discoverProviderModels(
  provider: Record<string, unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelDiscoveryResult> {
  try {
    if (!provider || typeof provider !== "object" || Array.isArray(provider))
      throw new Error("Provider configuration is required");
    if (provider.api && !["openai-completions", "openai-responses"].includes(String(provider.api)))
      throw new Error("Model discovery requires an OpenAI-compatible API");
    const endpoints = discoveryEndpoints(provider.baseUrl);
    const headers = await discoveryHeaders(provider);
    const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    for (const [index, endpoint] of endpoints.entries()) {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(endpoint, { headers, signal, redirect: "error" });
      } catch {
        return {
          ok: false,
          error: signal.aborted
            ? "Model discovery timed out. Check the server and retry."
            : "Could not connect to the models endpoint. Check the Base URL and network; redirects are not followed.",
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && index + 1 < endpoints.length) continue;
        return {
          ok: false,
          status: response.status,
          error:
            response.status === 401 || response.status === 403
              ? `Model discovery authentication failed (HTTP ${response.status}). Check the API key and headers.`
              : `The models endpoint returned HTTP ${response.status}. Check the Base URL.`,
        };
      }
      try {
        const models = await readModels(response);
        const baseUrl = new URL(endpoint);
        baseUrl.pathname = baseUrl.pathname.replace(/\/models$/, "");
        return { ok: true, models, baseUrl: baseUrl.href.replace(/\/$/, "") };
      } catch (error) {
        // Some gateways serve their HTML app at unknown paths, including /models.
        if (!signal.aborted && index + 1 < endpoints.length) continue;
        return {
          ok: false,
          error: signal.aborted
            ? "Model discovery timed out. Check the server and retry."
            : error instanceof Error
              ? error.message
              : "Invalid models response",
        };
      }
    }
    return { ok: false, error: "No models endpoint was found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Model discovery failed" };
  }
}
