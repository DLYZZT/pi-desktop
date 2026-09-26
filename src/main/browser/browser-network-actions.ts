import type { Session } from "electron";
import type { BrowserNetworkBodyResult, BrowserNetworkReplayResult } from "../../contract/browser.ts";
import type { BrowserNetworkRecorder } from "./browser-network-recorder.ts";
import { BrowserError } from "./browser-error.ts";
import {
  MAX_REPLAY_RESPONSE_BYTES,
  readBoundedResponseBody,
  runBoundedNetworkAction,
} from "./browser-response-body.ts";

export interface BrowserNetworkActionServices {
  recorder: Pick<
    BrowserNetworkRecorder,
    "armBodyCapture" | "body" | "getRequest" | "getSealedReplayRecord" | "recordRefetchedBody" | "recordReplay"
  >;
  session: Pick<Session, "fetch">;
  checkUrl: (url: string) => Promise<{ url: string }>;
  timeoutMs: () => number;
}

export async function readBrowserNetworkBody(
  services: BrowserNetworkActionServices,
  requestId: string,
  input: { full?: boolean; offset?: number; maxBytes?: number },
  signal: AbortSignal,
): Promise<BrowserNetworkBodyResult> {
  const recorder = services.recorder;
  recorder.armBodyCapture();
  try {
    return await recorder.body(requestId, input);
  } catch (error) {
    const request = recorder.getRequest(requestId);
    if (!(error instanceof BrowserError) || request.method !== "GET") throw error;
    const sealed = recorder.getSealedReplayRecord(requestId);
    const checked = await services.checkUrl(sealed.url);
    return runBoundedNetworkAction(signal, services.timeoutMs(), async (networkSignal) => {
      const response = await services.session.fetch(checked.url, {
        method: "GET",
        headers: replayHeaders(sealed.headers),
        redirect: "error",
        signal: networkSignal,
      });
      const data = await readBoundedResponseBody(response, MAX_REPLAY_RESPONSE_BYTES, networkSignal);
      const mimeType = response.headers.get("content-type") ?? request.mimeType ?? "application/octet-stream";
      return recorder.recordRefetchedBody(requestId, data, mimeType);
    });
  }
}

export async function replayBrowserRequest(
  services: BrowserNetworkActionServices,
  requestId: string,
  overrides: { url?: string; headers?: Record<string, string>; body?: string } | undefined,
  reason: string,
  signal: AbortSignal,
  approve: (description: string) => Promise<void>,
): Promise<BrowserNetworkReplayResult> {
  const recorder = services.recorder;
  recorder.armBodyCapture();
  const sealed = recorder.getSealedReplayRecord(requestId);
  const method = sealed.method.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new BrowserError("REQUEST_REPLAY_BLOCKED", `Browser request method cannot be replayed: ${method}`);
  }
  const targetUrl = validateReplayUrl(overrides?.url ?? sealed.url);
  const checked = await services.checkUrl(targetUrl);
  const headers = { ...replayHeaders(sealed.headers), ...validateReplayOverrides(overrides?.headers) };
  const body = overrides?.body ?? sealed.postData;
  if (body !== undefined && Buffer.byteLength(body) > 8 * 1024 * 1024) {
    throw new BrowserError("RESULT_TOO_LARGE", "Browser request replay body is too large");
  }
  if (!["GET", "HEAD"].includes(method)) {
    await approve(
      `Replay ${method} to ${new URL(checked.url).origin} (${headers["content-type"] ?? "unknown content type"}, ${Buffer.byteLength(body ?? "")} bytes): ${reason.trim()}`,
    );
  }
  return runBoundedNetworkAction(signal, services.timeoutMs(), async (networkSignal) => {
    let url = checked.url;
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
      try {
        response = await services.session.fetch(url, {
          method,
          headers,
          ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
          redirect: "manual",
          signal: networkSignal,
        });
      } catch (error) {
        if (/redirect.*(?:cancel|block)/i.test(error instanceof Error ? error.message : String(error))) {
          throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Browser request replay redirect was blocked");
        }
        throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser request replay failed", {
          retryable: false,
          cause: error,
        });
      }
      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400) break;
      const next = new URL(location, url);
      if (next.origin !== new URL(url).origin) {
        throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Cross-origin request replay redirect was blocked");
      }
      if (method !== "GET" && method !== "HEAD") break;
      url = (await services.checkUrl(next.toString())).url;
    }
    if (!response) throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser request replay failed");
    const responseData = await readBoundedResponseBody(response, MAX_REPLAY_RESPONSE_BYTES, networkSignal);
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const replayed = recorder.recordReplay({
      replayedFrom: requestId,
      method,
      url,
      requestHeaders: headers,
      status: response.status,
      statusText: response.statusText,
      responseHeaders,
      body: responseData,
      mimeType,
    });
    return {
      request: replayed,
      ...(responseData.byteLength
        ? { responseBody: await recorder.body(replayed.requestId, { maxBytes: 512 * 1024 }) }
        : {}),
    };
  });
}

function validateReplayUrl(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser request replay URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser request replay URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Browser request replay protocol is blocked");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function replayHeaders(value: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "host",
    "cookie",
    "content-length",
    "proxy-authorization",
    "connection",
    "transfer-encoding",
  ]);
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || blocked.has(normalized) || normalized.startsWith("sec-")) continue;
    if (/[\0\r\n]/.test(name) || /[\0\r\n]/.test(headerValue)) continue;
    result[normalized] = headerValue.slice(0, 16_384);
  }
  return result;
}

function validateReplayOverrides(value?: Record<string, string>): Record<string, string> {
  if (!value) return {};
  if (Object.keys(value).length > 100) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Too many Browser request replay header overrides");
  }
  const normalized = replayHeaders(value);
  if (Object.keys(normalized).length !== Object.keys(value).length) {
    throw new BrowserError("REQUEST_REPLAY_BLOCKED", "A protected Browser request header cannot be overridden");
  }
  return normalized;
}
