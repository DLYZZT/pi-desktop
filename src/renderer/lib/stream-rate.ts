/**
 * Sliding-window token rate for the streaming "x t/s" badge.
 *
 * Unlike a cumulative average (total tokens / total elapsed), a sliding window
 * only compares recent samples, so remounting mid-stream — switching sessions
 * and back while the agent keeps generating — cannot spike the value: the new
 * instance starts sampling from the current content size, and only tokens that
 * arrive afterwards enter the rate.
 */

/** How far back the rate window looks. */
const WINDOW_MS = 4000;
/** Samples older than this are stale even if the window is short (throttled ticks). */
const SAMPLE_TTL_MS = 8000;
/** Below this the stream is effectively idle; hide the badge instead of showing noise. */
const MIN_RATE = 0.5;

export interface StreamRateSample {
  /** Time of the observation, ms epoch. */
  at: number;
  /** Estimated token count of the whole streaming message at that time. */
  tokens: number;
}

export interface StreamRateState {
  samples: StreamRateSample[];
}

export function createStreamRateState(): StreamRateState {
  return { samples: [] };
}

export function resetStreamRate(state: StreamRateState): void {
  state.samples = [];
}

/** Estimated token count from the character total of all streaming blocks. */
export function estimateTokens(chars: number): number {
  return chars / 4;
}

/**
 * Character estimate for a tool call input without serializing it.
 * JSON.stringify copies and escapes the entire payload — O(total chars) on
 * every streaming frame for large edit/write inputs — while summing string
 * lengths only walks the value's nodes. The result approximates the JSON text
 * length closely enough for the token badge and rate window.
 */
export function estimateToolInputChars(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += estimateToolInputChars(item) + 1;
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    for (const [key, item] of Object.entries(value)) total += key.length + 3 + estimateToolInputChars(item) + 1;
    return total;
  }
  return 0;
}

/**
 * Record a sample and return the rate over the window, in tokens per second.
 * Returns null while there is no usable span (single sample, window under ~1s,
 * or an idle stream), so partial windows don't produce absurd values.
 */
export function updateStreamRate(state: StreamRateState, now: number, tokens: number): number | null {
  const samples = state.samples;
  // Content can shrink (block replaced, stream restarted); start over.
  if (tokens < (samples.at(-1)?.tokens ?? 0)) samples.length = 0;
  samples.push({ at: now, tokens });
  // Keep the window short, but always retain the newest pair for the rate.
  while (samples.length > 2 && now - samples[0].at > WINDOW_MS) samples.shift();
  while (samples.length > 0 && now - samples[0].at > SAMPLE_TTL_MS) samples.shift();

  const first = samples[0];
  if (!first || first === samples.at(-1)) return null;
  const dt = (now - first.at) / 1000;
  if (dt < 1) return null;
  const rate = (tokens - first.tokens) / dt;
  return rate > MIN_RATE ? rate : null;
}
