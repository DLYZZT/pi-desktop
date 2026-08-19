// Pure path-comparison helpers shared by the Agent Host and the renderer.
// Keep this module free of Node.js dependencies — the renderer bundles it.
import { normalizeSlashes } from "./allowed-roots.ts";

// The sandboxed renderer main world has no `process` global (accessing it
// throws), so the platform must come from piBridge, which the preload
// exposes, when running there. Without either source, "" keeps comparison
// case-sensitive instead of crashing.
function detectComparisonPlatform(): NodeJS.Platform | "" {
  if (typeof process !== "undefined" && process.platform) return process.platform;
  const bridge = (globalThis as { piBridge?: { platform?: NodeJS.Platform } }).piBridge;
  return bridge?.platform ?? "";
}

export function normalizeWorktreePathForComparison(
  filePath: string,
  platform: NodeJS.Platform | "" = detectComparisonPlatform(),
): string {
  let normalized = normalizeSlashes(filePath.trim());
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function worktreePathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform | "" = detectComparisonPlatform(),
): boolean {
  return normalizeWorktreePathForComparison(left, platform) === normalizeWorktreePathForComparison(right, platform);
}
