const TRACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
let traceSequence = 0;

export function sessionPerformanceEnabled(): boolean {
  return process.env.PI_DESKTOP_SESSION_PERF === "1";
}

export function sessionPerformanceBytesEnabled(): boolean {
  return process.env.PI_DESKTOP_SESSION_PERF_BYTES === "1";
}

export function resolveSessionTraceId(requested?: string): string {
  if (requested && TRACE_ID_RE.test(requested)) return requested;
  traceSequence += 1;
  return `host_${Date.now().toString(36)}_${traceSequence.toString(36)}`;
}

export function roundSessionMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}

export function logSessionPerformance(event: string, fields: Record<string, unknown>): void {
  if (!sessionPerformanceEnabled()) return;
  const message = `[perf:sessions] ${JSON.stringify({ event, ...fields })}`;
  try {
    process.parentPort?.postMessage({ type: "log", message });
  } catch {
    console.debug(`[agent-host] ${message}`);
  }
}
