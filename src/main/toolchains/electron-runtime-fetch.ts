import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import { assertRuntimeRedirectUrl, MAX_RUNTIME_REDIRECTS } from "./downloader.ts";

export type ElectronRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
  }
  return headers;
}

function responseBody(
  response: IncomingMessage,
  request: ClientRequest,
  signal: AbortSignal | null,
): ReadableStream<Uint8Array> {
  let finished = false;
  let cleanup = (): void => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => {
        if (!finished) controller.enqueue(chunk);
      };
      const onEnd = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.close();
      };
      const onError = (error: Error): void => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.error(error);
      };
      const onAborted = (): void => onError(abortError());
      const onSignalAbort = (): void => {
        onAborted();
        request.abort();
      };
      cleanup = () => {
        response.removeListener("data", onData);
        response.removeListener("end", onEnd);
        response.removeListener("error", onError);
        response.removeListener("aborted", onAborted);
        signal?.removeEventListener("abort", onSignalAbort);
      };
      response.on("data", onData);
      response.on("end", onEnd);
      response.on("error", onError);
      response.on("aborted", onAborted);
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) onSignalAbort();
    },
    cancel() {
      if (finished) return;
      finished = true;
      cleanup();
      request.abort();
    },
  });
}

/**
 * Adapts Electron's Chromium-backed ClientRequest to fetch while retaining
 * synchronous, allowlisted redirect checks. Electron net.fetch rejects
 * redirect: "manual" before callers can inspect GitHub release redirects.
 */
export function createElectronRuntimeFetch(requestFactory: ElectronRequestFactory): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") {
      return Promise.reject(
        new ToolchainError({ code: "TOOLCHAIN_DOWNLOAD_REJECTED", message: "Managed downloads require GET" }),
      );
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let redirects = 0;
      const request = requestFactory({
        method,
        url: inputUrl,
        redirect: "manual",
        bypassCustomProtocolHandlers: true,
      });
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = (): void => {
        fail(abortError());
        request.abort();
      };

      request.on("redirect", (_statusCode, redirectMethod, redirectUrl) => {
        try {
          redirects += 1;
          if (redirects > MAX_RUNTIME_REDIRECTS) {
            throw new ToolchainError({
              code: "TOOLCHAIN_DOWNLOAD_REJECTED",
              message: "Artifact redirect limit exceeded",
            });
          }
          if (redirectMethod.toUpperCase() !== "GET") {
            throw new ToolchainError({
              code: "TOOLCHAIN_DOWNLOAD_REJECTED",
              message: "Artifact redirect changed the request method",
            });
          }
          assertRuntimeRedirectUrl(redirectUrl);
          // Electron requires this call synchronously inside the redirect event.
          request.followRedirect();
        } catch (error) {
          fail(error);
          request.abort();
        }
      });
      request.on("response", (response) => {
        if (settled) {
          request.abort();
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const status = response.statusCode;
        const body =
          status === 204 || status === 205 || status === 304 ? null : responseBody(response, request, signal);
        resolve(
          new Response(body, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders(response),
          }),
        );
      });
      request.on("error", fail);
      // ClientRequest can emit close while a validated redirect transitions to
      // its next connection. It is not terminal; errors and the caller timeout
      // remain responsible for rejecting a request that never yields a response.

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
      }
      for (const [name, value] of headers) request.setHeader(name, value);
      signal?.addEventListener("abort", onAbort, { once: true });
      request.end();
    });
  }) as typeof fetch;
}
