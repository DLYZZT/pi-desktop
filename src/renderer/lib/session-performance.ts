export type SessionLoadSource = "selection" | "restore" | "initial" | "refresh";

export interface SessionLoadTrace {
  id: string;
  sessionId: string;
  source: SessionLoadSource;
  startedAt: number;
}

export const SESSION_LOAD_TRACE_TTL_MS = 60_000;
export const MAX_PENDING_SESSION_LOAD_TRACES = 128;

export class PendingSessionLoadTraceRegistry {
  private readonly pending = new Map<string, SessionLoadTrace>();
  private readonly now: () => number;
  private readonly onDiscard: (trace: SessionLoadTrace) => void;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    now: () => number,
    onDiscard: (trace: SessionLoadTrace) => void,
    ttlMs = SESSION_LOAD_TRACE_TTL_MS,
    maxEntries = MAX_PENDING_SESSION_LOAD_TRACES,
  ) {
    this.now = now;
    this.onDiscard = onDiscard;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  set(trace: SessionLoadTrace): void {
    this.prune();
    const replaced = this.pending.get(trace.sessionId);
    if (replaced && replaced !== trace) this.discard(trace.sessionId, replaced);
    else this.pending.delete(trace.sessionId);
    this.pending.set(trace.sessionId, trace);
    while (this.pending.size > this.maxEntries) {
      const oldest = this.pending.entries().next().value as [string, SessionLoadTrace] | undefined;
      if (!oldest) break;
      this.discard(oldest[0], oldest[1]);
    }
  }

  take(sessionId: string): SessionLoadTrace | undefined {
    this.prune();
    const trace = this.pending.get(sessionId);
    if (trace) this.pending.delete(sessionId);
    return trace;
  }

  delete(trace: SessionLoadTrace): boolean {
    if (this.pending.get(trace.sessionId) !== trace) return false;
    return this.pending.delete(trace.sessionId);
  }

  get size(): number {
    return this.pending.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, trace] of this.pending) {
      if (now - trace.startedAt >= this.ttlMs) this.discard(sessionId, trace);
    }
  }

  private discard(sessionId: string, trace: SessionLoadTrace): void {
    if (this.pending.get(sessionId) !== trace) return;
    this.pending.delete(sessionId);
    this.onDiscard(trace);
  }
}

let traceSequence = 0;
const TRACE_PHASES = ["selected", "rpc-start", "rpc-end", "react-commit", "interactive", "failed"] as const;

function perfAvailable(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

function perfDebugEnabled(): boolean {
  if (import.meta.env?.DEV) return true;
  try {
    return window.localStorage.getItem("pi:session-performance") === "1";
  } catch {
    return false;
  }
}

function markName(trace: SessionLoadTrace, phase: string): string {
  return `pi-session-load:${trace.id}:${phase}`;
}

function elapsed(trace: SessionLoadTrace, from: string, to: string): number | null {
  if (!perfAvailable()) return null;
  const start = performance.getEntriesByName(markName(trace, from), "mark").at(-1)?.startTime;
  const end = performance.getEntriesByName(markName(trace, to), "mark").at(-1)?.startTime;
  return start === undefined || end === undefined ? null : Math.round((end - start) * 10) / 10;
}

function traceNow(): number {
  return perfAvailable() ? performance.now() : Date.now();
}

function clearSessionLoadTrace(trace: SessionLoadTrace): void {
  if (!perfAvailable()) return;
  for (const phase of TRACE_PHASES) performance.clearMarks(markName(trace, phase));
}

const pendingBySession = new PendingSessionLoadTraceRegistry(traceNow, clearSessionLoadTrace);

function createSessionLoadTrace(sessionId: string, source: SessionLoadSource): SessionLoadTrace {
  traceSequence += 1;
  const trace: SessionLoadTrace = {
    id: `sl_${Date.now().toString(36)}_${traceSequence.toString(36)}`,
    sessionId,
    source,
    startedAt: traceNow(),
  };
  markSessionLoadPhase(trace, "selected");
  return trace;
}

export function beginSessionLoadTrace(sessionId: string, source: SessionLoadSource): SessionLoadTrace {
  const trace = createSessionLoadTrace(sessionId, source);
  pendingBySession.set(trace);
  return trace;
}

export function consumeSessionLoadTrace(sessionId: string, fallbackSource: SessionLoadSource): SessionLoadTrace {
  return pendingBySession.take(sessionId) ?? createSessionLoadTrace(sessionId, fallbackSource);
}

export function markSessionLoadPhase(trace: SessionLoadTrace, phase: string): void {
  if (!perfAvailable()) return;
  performance.mark(markName(trace, phase));
}

export function finishSessionLoadTrace(trace: SessionLoadTrace): void {
  pendingBySession.delete(trace);
  markSessionLoadPhase(trace, "interactive");
  if (perfDebugEnabled()) {
    console.debug(
      `[perf:sessions] ${JSON.stringify({
        traceId: trace.id,
        source: trace.source,
        totalMs: elapsed(trace, "selected", "interactive"),
        rpcMs: elapsed(trace, "rpc-start", "rpc-end"),
        commitToInteractiveMs: elapsed(trace, "react-commit", "interactive"),
      })}`,
    );
  }
  clearSessionLoadTrace(trace);
}

export function failSessionLoadTrace(trace: SessionLoadTrace): void {
  pendingBySession.delete(trace);
  markSessionLoadPhase(trace, "failed");
  if (perfDebugEnabled()) {
    console.debug(
      `[perf:sessions] ${JSON.stringify({
        traceId: trace.id,
        source: trace.source,
        failed: true,
        totalMs: elapsed(trace, "selected", "failed"),
      })}`,
    );
  }
  clearSessionLoadTrace(trace);
}

export function logSessionPerformanceEvent(event: string, fields: Record<string, unknown>): void {
  if (!perfDebugEnabled()) return;
  console.debug(`[perf:sessions] ${JSON.stringify({ event, ...fields })}`);
}
