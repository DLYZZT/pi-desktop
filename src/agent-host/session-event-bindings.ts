import type { RpcServer } from "../contract/rpc";
import { SessionEventBatcher, type SessionEventBatchOptions } from "./session-event-batcher.ts";

export interface SessionEventSource {
  sessionId: string;
  onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
  onDestroy?(callback: () => void): void | (() => void);
}
type Binding = {
  source: SessionEventSource;
  id: string;
  active: boolean;
  eventOff?: () => void;
  destroyOff?: () => void;
  discardPending?: () => void;
};

/** One registry owns subscriptions for one Host RPC server lifetime. */
export function createSessionEventBindings(
  server: Pick<RpcServer, "emit">,
  notifyEnd: (sessionId: string) => void = (sessionId) => {
    try {
      process.parentPort?.postMessage({ type: "agent-end", sessionId, eventType: "agent_end" });
    } catch {
      /* best effort */
    }
  },
  batchOptions: SessionEventBatchOptions = {},
) {
  const byId = new Map<string, Binding>(),
    bySource = new WeakMap<object, Binding>();
  let closed = false;
  const release = (callback?: () => void) => {
    try {
      callback?.();
    } catch {
      /* continue releasing other bindings */
    }
  };
  const retire = (binding: Binding) => {
    if (!binding.active) return;
    binding.active = false;
    if (byId.get(binding.id) === binding) byId.delete(binding.id);
    if (bySource.get(binding.source) === binding) bySource.delete(binding.source);
    release(binding.discardPending);
    release(binding.eventOff);
    release(binding.destroyOff);
  };
  const clear = (id: string) => {
    const binding = byId.get(id);
    if (binding) retire(binding);
  };
  return {
    clear,
    ensure(source: SessionEventSource, fallbackId: string) {
      if (closed || bySource.get(source)?.active) return;
      const id = source.sessionId || fallbackId;
      clear(id);
      const binding: Binding = { source, id, active: true };
      byId.set(id, binding);
      bySource.set(source, binding);
      try {
        const batcher = new SessionEventBatcher((event) => {
          if (!binding.active || byId.get(id) !== binding) return;
          server.emit("agent.events", id, event as never);
          if (event.type === "agent_end") notifyEnd(id);
        }, batchOptions);
        binding.discardPending = () => batcher.dispose();
        const eventOff = source.onEvent((event) => batcher.push(event));
        if (binding.active) binding.eventOff = eventOff;
        else release(eventOff);
        const destroyOff = source.onDestroy?.(() => retire(binding));
        if (typeof destroyOff === "function") {
          if (binding.active) binding.destroyOff = destroyOff;
          else release(destroyOff);
        }
      } catch (error) {
        retire(binding);
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const binding of [...byId.values()]) retire(binding);
    },
  };
}
