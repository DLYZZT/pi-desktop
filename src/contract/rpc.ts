/**
 * Lightweight MessagePort RPC (no external framework).
 * Five message kinds: request / response / subscribe / unsubscribe / event.
 * Protocol spec: docs/rpc-protocol.md
 */

import type { ApiMethod, ApiParams, ApiResult, StreamTopic, Streams } from "./api";
import { RpcError, type RpcErrorShape } from "./types.ts";

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export type WireRequest = {
  kind: "request";
  id: string;
  method: string;
  params: unknown;
};

export type WireResponse = {
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: RpcErrorShape;
};

export type WireEvent = {
  kind: "event";
  topic: string;
  key: string;
  data: unknown;
};

export type WireSubscribe = {
  kind: "subscribe";
  id: string;
  topic: string;
  key: string;
};

export type WireUnsubscribe = {
  kind: "unsubscribe";
  id: string;
  topic: string;
  key: string;
};

export type WireMessage = WireRequest | WireResponse | WireEvent | WireSubscribe | WireUnsubscribe;

// ---------------------------------------------------------------------------
// Client (renderer / any consumer)
// ---------------------------------------------------------------------------

export interface PiRpc {
  call<M extends ApiMethod>(
    method: M,
    ...args: ApiParams<M> extends void ? [] | [void] : [ApiParams<M>]
  ): Promise<ApiResult<M>>;
  subscribe<T extends StreamTopic>(topic: T, key: string, on: (ev: Streams[T]) => void): () => void;
  close(): void;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

type SubEntry = {
  topic: string;
  key: string;
  handler: (ev: unknown) => void;
};

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `r${nextId}_${Date.now().toString(36)}`;
}

export function createRpcClient(port: MessagePort): PiRpc {
  const pending = new Map<string, Pending>();
  const subs = new Map<string, SubEntry>();

  const onMessage = (ev: MessageEvent) => {
    const msg = ev.data as WireMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.kind === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        p.reject(new RpcError(msg.error ?? { code: "UNKNOWN", message: "Unknown RPC error" }));
      }
      return;
    }

    if (msg.kind === "event") {
      for (const sub of subs.values()) {
        if (sub.topic === msg.topic && (sub.key === "*" || sub.key === msg.key || msg.key === "*")) {
          try {
            sub.handler(msg.data);
          } catch {
            /* ignore subscriber errors */
          }
        }
      }
    }
  };

  port.addEventListener("message", onMessage);
  port.start();

  return {
    call(method, ...args) {
      const params = (args[0] ?? undefined) as unknown;
      const id = makeId();
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        const req: WireRequest = {
          kind: "request",
          id,
          method: method as string,
          params,
        };
        try {
          port.postMessage(req);
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    subscribe(topic, key, on) {
      const id = makeId();
      subs.set(id, {
        topic: topic as string,
        key,
        handler: on as (ev: unknown) => void,
      });
      const msg: WireSubscribe = {
        kind: "subscribe",
        id,
        topic: topic as string,
        key,
      };
      try {
        port.postMessage(msg);
      } catch {
        /* port may already be closed */
      }
      return () => {
        subs.delete(id);
        const unsub: WireUnsubscribe = {
          kind: "unsubscribe",
          id,
          topic: topic as string,
          key,
        };
        try {
          port.postMessage(unsub);
        } catch {
          /* ignore */
        }
      };
    },

    close() {
      port.removeEventListener("message", onMessage);
      for (const [, p] of pending) {
        p.reject(new RpcError({ code: "CLOSED", message: "RPC port closed" }));
      }
      pending.clear();
      subs.clear();
      try {
        port.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Server (agent-host)
// ---------------------------------------------------------------------------

export type ApiHandler = {
  [M in ApiMethod]?: (params: ApiParams<M>) => Promise<ApiResult<M>> | ApiResult<M>;
};

export type StreamSink = {
  topic: string;
  key: string;
  emit: (data: unknown) => void;
};

/**
 * Port shape that works in both:
 * - Renderer DOM MessagePort (addEventListener + MessageEvent.data)
 * - utilityProcess / Node worker_threads MessagePort (EventEmitter .on('message'))
 * - Electron MessagePortMain (.on('message', (e) => e.data))
 */
export type AnyMessagePort = {
  postMessage: (message: unknown, transfer?: unknown[]) => void;
  start?: () => void;
  close?: () => void;
  addEventListener?: (type: string, listener: (ev: { data: unknown }) => void) => void;
  removeEventListener?: (type: string, listener: (ev: { data: unknown }) => void) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export interface RpcServer {
  handle(handlers: ApiHandler): void;
  emit<T extends StreamTopic>(topic: T, key: string, data: Streams[T]): void;
  attachPort(port: AnyMessagePort): void;
  detachPort(port: AnyMessagePort): void;
}

function extractMessageData(arg: unknown): unknown {
  // DOM MessageEvent / Electron MessagePortMain event: { data }
  if (arg && typeof arg === "object" && "data" in arg && !("kind" in arg)) {
    return (arg as { data: unknown }).data;
  }
  // Node worker_threads MessagePort: payload is the value itself
  return arg;
}

function listenPort(port: AnyMessagePort, onData: (data: unknown) => void): () => void {
  if (typeof port.addEventListener === "function") {
    const listener = (ev: { data: unknown }) => onData(ev.data);
    port.addEventListener("message", listener);
    port.start?.();
    return () => port.removeEventListener?.("message", listener);
  }

  if (typeof port.on === "function") {
    const listener = (...args: unknown[]) => {
      onData(extractMessageData(args[0]));
    };
    port.on("message", listener);
    port.start?.();
    return () => {
      port.off?.("message", listener);
      port.removeListener?.("message", listener);
    };
  }

  throw new Error("MessagePort has neither addEventListener nor on()");
}

export function createRpcServer(): RpcServer {
  const handlers: ApiHandler = {};
  const ports = new Set<AnyMessagePort>();
  /** port → subscription id → { topic, key } */
  const portSubs = new Map<AnyMessagePort, Map<string, { topic: string; key: string }>>();
  const portUnlisten = new Map<AnyMessagePort, () => void>();
  const portCloseUnlisten = new Map<AnyMessagePort, () => void>();

  function forgetPort(port: AnyMessagePort): void {
    ports.delete(port);
    portSubs.delete(port);
    portUnlisten.get(port)?.();
    portUnlisten.delete(port);
    portCloseUnlisten.get(port)?.();
    portCloseUnlisten.delete(port);
  }

  function ensureSubs(port: AnyMessagePort): Map<string, { topic: string; key: string }> {
    let m = portSubs.get(port);
    if (!m) {
      m = new Map();
      portSubs.set(port, m);
    }
    return m;
  }

  async function onPortMessage(port: AnyMessagePort, raw: unknown) {
    const msg = raw as WireMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.kind === "subscribe") {
      ensureSubs(port).set(msg.id, { topic: msg.topic, key: msg.key });
      return;
    }
    if (msg.kind === "unsubscribe") {
      ensureSubs(port).delete(msg.id);
      return;
    }
    if (msg.kind !== "request") return;

    const handler = handlers[msg.method as ApiMethod] as ((params: unknown) => Promise<unknown> | unknown) | undefined;

    let response: WireResponse;
    try {
      if (!handler) {
        throw new RpcError({
          code: "METHOD_NOT_FOUND",
          message: `Unknown method: ${msg.method}`,
        });
      }
      const result = await handler(msg.params);
      response = { kind: "response", id: msg.id, ok: true, result };
    } catch (err) {
      const error: RpcErrorShape =
        err instanceof RpcError
          ? { code: err.code, message: err.message, detail: err.detail }
          : {
              code: "INTERNAL",
              message: err instanceof Error ? err.message : String(err),
            };
      response = { kind: "response", id: msg.id, ok: false, error };
    }
    try {
      port.postMessage(response);
    } catch {
      /* port closed */
    }
  }

  return {
    handle(next) {
      Object.assign(handlers, next);
    },

    emit(topic, key, data) {
      const wire: WireEvent = {
        kind: "event",
        topic: topic as string,
        key,
        data,
      };
      for (const port of ports) {
        const subs = portSubs.get(port);
        if (!subs) continue;
        let match = false;
        for (const sub of subs.values()) {
          if (sub.topic === topic && (sub.key === "*" || sub.key === key || key === "*")) {
            match = true;
            break;
          }
        }
        if (!match) continue;
        try {
          port.postMessage(wire);
        } catch {
          /* ignore */
        }
      }
    },

    attachPort(port) {
      if (ports.has(port)) return;
      ports.add(port);
      ensureSubs(port);
      const unlisten = listenPort(port, (data) => {
        void onPortMessage(port, data);
      });
      portUnlisten.set(port, unlisten);
      // ISSUE-013: drop port when remote closes
      const onClose = () => {
        forgetPort(port);
      };
      if (typeof port.addEventListener === "function") {
        port.addEventListener("close", onClose as (ev: { data: unknown }) => void);
        portCloseUnlisten.set(port, () => {
          port.removeEventListener?.("close", onClose as (ev: { data: unknown }) => void);
        });
      } else if (typeof port.on === "function") {
        port.on("close", onClose);
        portCloseUnlisten.set(port, () => {
          if (typeof port.off === "function") port.off("close", onClose);
          else port.removeListener?.("close", onClose);
        });
      }
    },

    detachPort(port) {
      if (!ports.has(port)) return;
      forgetPort(port);
      try {
        port.close?.();
      } catch {
        /* ignore */
      }
    },
  };
}
