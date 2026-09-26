import type { BrowserSnapshotNode } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

export function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function screenshotRectForNode(
  node: BrowserSnapshotNode | undefined,
  maxPixels: number,
): { x: number; y: number; width: number; height: number } {
  if (!node?.bounds) throw new BrowserError("STALE_ELEMENT_REF", "Browser element has no current screenshot bounds");
  const x = Math.max(0, Math.floor(node.bounds.x));
  const y = Math.max(0, Math.floor(node.bounds.y));
  const width = Math.max(1, Math.ceil(node.bounds.width));
  const height = Math.max(1, Math.ceil(node.bounds.height));
  if (width * height > maxPixels) {
    throw new BrowserError("RESULT_TOO_LARGE", "Browser element screenshot exceeds the pixel limit");
  }
  return { x, y, width, height };
}
