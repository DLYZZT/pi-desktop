export type SessionLoadSource = "selection" | "restore" | "initial" | "refresh";

export interface SessionLoadTrace {
  id: string;
  source: SessionLoadSource;
  startedAt: number;
}

const pendingBySession = new Map<string, SessionLoadTrace>();
let traceSequence = 0;

function perfAvailable(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

function perfDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
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

export function beginSessionLoadTrace(sessionId: string, source: SessionLoadSource): SessionLoadTrace {
  traceSequence += 1;
  const trace: SessionLoadTrace = {
    id: `sl_${Date.now().toString(36)}_${traceSequence.toString(36)}`,
    source,
    startedAt: perfAvailable() ? performance.now() : Date.now(),
  };
  pendingBySession.set(sessionId, trace);
  markSessionLoadPhase(trace, "selected");
  return trace;
}

export function consumeSessionLoadTrace(sessionId: string, fallbackSource: SessionLoadSource): SessionLoadTrace {
  const pending = pendingBySession.get(sessionId);
  if (pending) {
    pendingBySession.delete(sessionId);
    return pending;
  }
  return beginSessionLoadTrace(sessionId, fallbackSource);
}

export function markSessionLoadPhase(trace: SessionLoadTrace, phase: string): void {
  if (!perfAvailable()) return;
  performance.mark(markName(trace, phase));
}

export function finishSessionLoadTrace(trace: SessionLoadTrace): void {
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
  if (!perfAvailable()) return;
  for (const phase of ["selected", "rpc-start", "rpc-end", "react-commit", "interactive"]) {
    performance.clearMarks(markName(trace, phase));
  }
}

export function failSessionLoadTrace(trace: SessionLoadTrace): void {
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
}

export function logSessionPerformanceEvent(event: string, fields: Record<string, unknown>): void {
  if (!perfDebugEnabled()) return;
  console.debug(`[perf:sessions] ${JSON.stringify({ event, ...fields })}`);
}
