export interface HeartbeatTickInput {
  now: number;
  lastTickAt: number;
  lastAcknowledgedAt: number;
  intervalMs: number;
  timeoutMs: number;
}

export interface HeartbeatTickResult {
  timedOut: boolean;
  clockDiscontinuity: boolean;
}

/**
 * Distinguish an unresponsive peer from a timer that could not run while the
 * machine was suspended (or while this event loop was paused). Ownership
 * safety is enforced separately by process handles and pipe EOF, so after a
 * clock discontinuity the caller can safely re-establish one heartbeat before
 * declaring the peer dead.
 */
export function evaluateHeartbeatTick(input: HeartbeatTickInput): HeartbeatTickResult {
  const failureThresholdMs = input.intervalMs + input.timeoutMs;
  const tickGapMs = input.now - input.lastTickAt;
  const acknowledgementGapMs = input.now - input.lastAcknowledgedAt;
  const clockDiscontinuity = tickGapMs < 0 || acknowledgementGapMs < 0 || tickGapMs > failureThresholdMs;
  return {
    timedOut: !clockDiscontinuity && acknowledgementGapMs > failureThresholdMs,
    clockDiscontinuity,
  };
}
