import net from "node:net";
import { lstat } from "node:fs/promises";
import type { HerdrV20Method, JsonRecord } from "./protocol-v20";
import { isRecord } from "./protocol-v20";
import { HerdrBridgeError } from "./errors";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

let requestSequence = 0;

function nextRequestId(scope = "request"): string {
  requestSequence = requestSequence === Number.MAX_SAFE_INTEGER ? 1 : requestSequence + 1;
  return `pi-desktop:${scope}:${requestSequence}`;
}

type PendingRequest = {
  method: HerdrV20Method;
  params: JsonRecord;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type EndpointIdentity = {
  dev: bigint;
  ino: bigint;
};

function upstreamError(code: string, message: string): HerdrBridgeError {
  void message;
  if (code === "agent_blocked")
    return new HerdrBridgeError("HERDR_AGENT_BLOCKED", "The Herdr agent is blocked.", false);
  if (code === "timeout" || code === "agent_prompt_stalled") {
    return new HerdrBridgeError("HERDR_REQUEST_TIMEOUT", "The Herdr request timed out.", true);
  }
  if (code === "agent_not_running" || code === "agent_not_found") {
    return new HerdrBridgeError("HERDR_AGENT_NOT_READY", "The Herdr agent is not ready.", false);
  }
  if (code === "pane_not_found")
    return new HerdrBridgeError("HERDR_PANE_NOT_FOUND", "The requested Herdr pane was not found.", false);
  if (code === "session_not_found")
    return new HerdrBridgeError("HERDR_SESSION_NOT_FOUND", "The requested Herdr Session was not found.", false);
  if (code.includes("not_found"))
    return new HerdrBridgeError("HERDR_INVALID_REQUEST", "The requested Herdr object was not found.", false);
  return new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr rejected the request.", false);
}

export class HerdrSocketClient {
  constructor(private readonly endpoint: string) {}

  async assertSafeEndpoint(): Promise<void> {
    await this.inspectSafeEndpoint();
  }

  private async inspectSafeEndpoint(): Promise<EndpointIdentity | undefined> {
    if (process.platform === "win32") return undefined;
    let info;
    try {
      info = await lstat(this.endpoint, { bigint: true });
    } catch {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "The selected Herdr Session is not running.", true);
    }
    if (info.isSymbolicLink()) {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr endpoint must not be a symbolic link.");
    }
    if (!info.isSocket()) throw new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr endpoint is not a socket.");
    if ((Number(info.mode) & 0o077) !== 0) {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr socket must be accessible only to its owner.");
    }
    if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr socket is owned by another user.");
    }
    return { dev: info.dev, ino: info.ino };
  }

  private async createSafeConnection(): Promise<net.Socket> {
    const before = await this.inspectSafeEndpoint();
    const socket = net.createConnection({ path: this.endpoint });
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const finish = (error?: HerdrBridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          socket.destroy();
          reject(error);
        } else resolve(socket);
      };
      const onError = () =>
        finish(new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "The selected Herdr Session is unavailable.", true));
      const onClose = () =>
        finish(new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr closed the connection.", true));
      const onConnect = () => {
        void this.inspectSafeEndpoint().then(
          (after) => {
            if (before && after && (before.dev !== after.dev || before.ino !== after.ino)) {
              finish(new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr endpoint changed while connecting."));
              return;
            }
            finish();
          },
          (error) =>
            finish(
              error instanceof HerdrBridgeError
                ? error
                : new HerdrBridgeError("HERDR_ENDPOINT_UNSAFE", "The Herdr endpoint could not be verified."),
            ),
        );
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  request<T = JsonRecord>({ method, params, timeoutMs = DEFAULT_TIMEOUT_MS, signal }: PendingRequest): Promise<T> {
    const id = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      let socket: net.Socket | null = null;
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: unknown, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket?.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      const onAbort = () =>
        finish(new HerdrBridgeError("HERDR_REQUEST_CANCELLED", "Herdr request was cancelled.", false));
      const timer = setTimeout(
        () => finish(new HerdrBridgeError("HERDR_REQUEST_TIMEOUT", `Herdr ${method} timed out.`, true)),
        timeoutMs,
      );
      timer.unref();
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.createSafeConnection().then(
        (connected) => {
          if (settled) {
            connected.destroy();
            return;
          }
          socket = connected;
          socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > MAX_LINE_BYTES) {
              finish(new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Herdr response exceeded 4 MiB."));
              return;
            }
            const newline = buffer.indexOf(0x0a);
            if (newline === -1) return;
            let response: unknown;
            try {
              response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
            } catch {
              finish(new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr returned invalid JSON."));
              return;
            }
            if (!isRecord(response) || response.id !== id) {
              finish(new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr response id is invalid."));
              return;
            }
            if (isRecord(response.error)) {
              const code = typeof response.error.code === "string" ? response.error.code : "unknown_error";
              const message =
                typeof response.error.message === "string" ? response.error.message : "Herdr request failed";
              finish(upstreamError(code, message));
              return;
            }
            if (!isRecord(response.result)) {
              finish(new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr response result is invalid."));
              return;
            }
            finish(undefined, response.result as T);
          });
          socket.once("error", () => {
            finish(
              new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "The selected Herdr Session is unavailable.", true),
            );
          });
          socket.once("end", () => {
            if (!settled)
              finish(new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr closed the connection.", true));
          });
          socket.write(`${JSON.stringify({ id, method, params })}\n`);
        },
        (error) => finish(error),
      );
    });
  }

  subscribe(
    subscriptions: readonly string[],
    onEvent: (event: JsonRecord) => void,
    onClose: (error?: HerdrBridgeError) => void,
    onReady?: () => void,
  ): () => void {
    let socket: net.Socket | null = null;
    const id = nextRequestId("events");
    let buffer = Buffer.alloc(0);
    let closed = false;
    let started = false;
    const allowedEvents = new Set(subscriptions);
    const close = (error?: HerdrBridgeError) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      socket?.destroy();
      onClose(error);
    };
    const handshakeTimer = setTimeout(
      () => close(new HerdrBridgeError("HERDR_REQUEST_TIMEOUT", "Herdr event subscription timed out.", true)),
      DEFAULT_TIMEOUT_MS,
    );
    handshakeTimer.unref();
    void this.createSafeConnection().then(
      (connected) => {
        if (closed) {
          connected.destroy();
          return;
        }
        socket = connected;
        socket.write(
          `${JSON.stringify({
            id,
            method: "events.subscribe",
            params: { subscriptions: subscriptions.map((type) => ({ type })) },
          })}\n`,
        );
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_LINE_BYTES) {
            close(new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Herdr event exceeded 4 MiB."));
            return;
          }
          while (true) {
            const newline = buffer.indexOf(0x0a);
            if (newline === -1) break;
            const line = buffer.subarray(0, newline).toString("utf8");
            buffer = buffer.subarray(newline + 1);
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              close(new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr event stream returned invalid JSON."));
              return;
            }
            if (!isRecord(value)) continue;
            if (value.id === id) {
              if (isRecord(value.error)) {
                close(upstreamError(String(value.error.code), String(value.error.message)));
                return;
              }
              if (!isRecord(value.result) || value.result.type !== "subscription_started" || started) {
                close(new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr event subscription response is invalid."));
                return;
              }
              started = true;
              clearTimeout(handshakeTimer);
              onReady?.();
              continue;
            }
            if (!started || value.type !== "event" || !isRecord(value.event)) continue;
            const eventType = value.event.type;
            if (typeof eventType !== "string" || !allowedEvents.has(eventType)) continue;
            onEvent(value);
          }
        });
        socket.once("error", () =>
          close(new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr event stream failed.", true)),
        );
        socket.once("end", () => close());
      },
      (error) =>
        close(
          error instanceof HerdrBridgeError
            ? error
            : new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr event stream failed.", true),
        ),
    );
    return () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      socket?.destroy();
    };
  }
}
