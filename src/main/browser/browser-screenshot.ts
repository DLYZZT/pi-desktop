import { nativeImage, type WebContents } from "electron";
import type {
  BrowserSnapshotNode,
  BrowserScreenshotMode,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserVisualCompareResult,
} from "../../contract/browser.ts";
import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { abortableDelay, withTimeout } from "./browser-action-timing.ts";
import { clampInteger, screenshotRectForNode } from "./browser-bounds.ts";
import { SNAPSHOT_WORLD_ID } from "./browser-dom-scripts.ts";

const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

const MAX_FULL_PAGE_HEIGHT = 16_384;

const MAX_SCREENSHOT_PIXELS = 32_000_000;

const MAX_COMPARE_PIXELS = 16_000_000;

type ScreenshotCdp = Pick<BrowserCdpCoordinator, "acquire" | "sendCommand">;
interface ScreenshotTarget {
  contents: WebContents;
  tabId: string;
  generation: () => number;
  element?: BrowserSnapshotNode;
}

export async function captureBrowserScreenshot(
  target: ScreenshotTarget,
  cdp: ScreenshotCdp,
  options: BrowserScreenshotOptions,
): Promise<BrowserScreenshotResult> {
  const format = options.format ?? "png";
  const quality = options.quality ?? 85;
  const mode = options.mode ?? "viewport";
  const generation = target.generation();
  let image: Electron.NativeImage | undefined;
  let captureError: unknown;
  if (mode !== "full-page") {
    const rect = mode === "element" ? screenshotRectForNode(target.element, MAX_SCREENSHOT_PIXELS) : undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        image = await withTimeout(
          target.contents.capturePage(rect, { stayHidden: true, stayAwake: true }),
          3_000,
          "ACTION_TIMEOUT",
        );
        if (!image.isEmpty()) break;
      } catch (error) {
        captureError = error;
      }
      await abortableDelay(100);
    }
    if (mode === "viewport" && (!image || image.isEmpty())) {
      try {
        image = await capturePresentedFrame(target.contents, 3_000);
      } catch (error) {
        captureError = error;
      }
    }
  }
  let buffer: Buffer;
  let size: Electron.Size;
  if (image && !image.isEmpty()) {
    size = image.getSize();
    buffer = format === "jpeg" ? image.toJPEG(clampInteger(quality, 1, 100)) : image.toPNG();
  } else {
    const clip = await screenshotClip(target, cdp, mode);
    if (clip.width * clip.height > MAX_SCREENSHOT_PIXELS) {
      throw new BrowserError("RESULT_TOO_LARGE", "Browser screenshot exceeds the pixel limit");
    }
    const releaseDebugger = cdp.acquire(target.tabId);
    try {
      const captured = (await withTimeout(
        cdp.sendCommand(target.tabId, "Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: clampInteger(quality, 1, 100) } : {}),
          fromSurface: true,
          captureBeyondViewport: mode === "full-page",
          clip: { ...clip, scale: 1 },
        }),
        8_000,
        "ACTION_TIMEOUT",
      )) as { data?: string };
      if (!captured.data) throw captureError ?? new Error("CDP screenshot returned no data");
      buffer = Buffer.from(captured.data, "base64");
      size = nativeImage.createFromBuffer(buffer).getSize();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const nativeReason = captureError instanceof Error ? captureError.message : String(captureError ?? "none");
      throw new BrowserError(
        "ACTION_TIMEOUT",
        `Browser screenshot surface is not ready (${reason}; native=${nativeReason})`,
        {
          retryable: true,
          cause: error,
        },
      );
    } finally {
      releaseDebugger();
    }
  }
  if (target.generation() !== generation) {
    throw new BrowserError("INSPECTION_STALE", "Browser page changed during screenshot", {
      details: { reason: "generation-changed" },
    });
  }
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new BrowserError("RESULT_TOO_LARGE", "Browser screenshot exceeds the result size limit");
  }
  return {
    tabId: target.tabId,
    mime: format === "jpeg" ? "image/jpeg" : "image/png",
    base64: buffer.toString("base64"),
    width: size.width,
    height: size.height,
    mode,
    generation,
    untrustedWebContent: true,
  };
}

async function screenshotClip(
  target: ScreenshotTarget,
  cdp: ScreenshotCdp,
  mode: BrowserScreenshotMode,
): Promise<{ x: number; y: number; width: number; height: number }> {
  if (mode === "element") {
    return screenshotRectForNode(target.element, MAX_SCREENSHOT_PIXELS);
  }
  if (mode === "full-page") {
    const releaseDebugger = cdp.acquire(target.tabId);
    try {
      const metrics = await cdp.sendCommand<{
        cssContentSize?: { width?: number; height?: number };
      }>(target.tabId, "Page.getLayoutMetrics");
      const width = clampInteger(Number(metrics.cssContentSize?.width), 1, 8_192);
      const rawHeight = Number(metrics.cssContentSize?.height);
      if (!Number.isFinite(rawHeight) || rawHeight <= 0 || rawHeight > MAX_FULL_PAGE_HEIGHT) {
        throw new BrowserError("RESULT_TOO_LARGE", "Browser full-page screenshot exceeds the height limit");
      }
      return { x: 0, y: 0, width, height: Math.ceil(rawHeight) };
    } finally {
      releaseDebugger();
    }
  }
  const viewport = (await target.contents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
    { code: "({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })" },
  ])) as { width?: unknown; height?: unknown };
  return {
    x: 0,
    y: 0,
    width: clampInteger(Number(viewport.width), 1, 8_192),
    height: clampInteger(Number(viewport.height), 1, 8_192),
  };
}

async function capturePresentedFrame(contents: WebContents, timeoutMs: number): Promise<Electron.NativeImage> {
  return new Promise<Electron.NativeImage>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!contents.isDestroyed()) {
        try {
          contents.endFrameSubscription();
        } catch {
          // The subscription may already have ended with the renderer.
        }
      }
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BrowserError("ACTION_TIMEOUT", "Browser frame capture timed out"))),
      timeoutMs,
    );
    try {
      contents.beginFrameSubscription(false, (frame) => {
        if (!frame.isEmpty()) finish(() => resolve(frame));
      });
      contents.invalidate();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export function compareScreenshots(
  left: BrowserScreenshotResult,
  right: BrowserScreenshotResult,
  threshold: number,
  includeDiff: boolean,
): BrowserVisualCompareResult {
  const leftImage = nativeImage.createFromBuffer(Buffer.from(left.base64, "base64"));
  const rightImage = nativeImage.createFromBuffer(Buffer.from(right.base64, "base64"));
  const leftSize = leftImage.getSize();
  const rightSize = rightImage.getSize();
  const dimensionsMatch = leftSize.width === rightSize.width && leftSize.height === rightSize.height;
  const width = Math.max(leftSize.width, rightSize.width);
  const height = Math.max(leftSize.height, rightSize.height);
  const totalPixels = width * height;
  if (totalPixels <= 0 || totalPixels > MAX_COMPARE_PIXELS) {
    throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser visual comparison exceeds the pixel limit");
  }
  if (!dimensionsMatch) {
    return {
      mode: left.mode,
      width,
      height,
      dimensionsMatch: false,
      differentPixels: totalPixels,
      totalPixels,
      differenceRatio: 1,
      regions: [{ x: 0, y: 0, width, height }],
      leftGeneration: left.generation,
      rightGeneration: right.generation,
      untrustedWebContent: true,
    };
  }
  const leftBitmap = leftImage.toBitmap();
  const rightBitmap = rightImage.toBitmap();
  if (leftBitmap.length !== rightBitmap.length || leftBitmap.length < totalPixels * 4) {
    throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser screenshot bitmap is unavailable");
  }
  const diffBitmap = includeDiff ? Buffer.alloc(leftBitmap.length) : undefined;
  let differentPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4;
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(leftBitmap[offset + channel]! - rightBitmap[offset + channel]!) > threshold) {
        different = true;
        break;
      }
    }
    if (different) {
      differentPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (diffBitmap) {
        diffBitmap[offset] = 0;
        diffBitmap[offset + 1] = 0;
        diffBitmap[offset + 2] = 255;
        diffBitmap[offset + 3] = 255;
      }
    } else if (diffBitmap) {
      diffBitmap[offset] = Math.round(leftBitmap[offset]! * 0.25);
      diffBitmap[offset + 1] = Math.round(leftBitmap[offset + 1]! * 0.25);
      diffBitmap[offset + 2] = Math.round(leftBitmap[offset + 2]! * 0.25);
      diffBitmap[offset + 3] = 255;
    }
  }
  let diff: BrowserScreenshotResult | undefined;
  if (diffBitmap) {
    const png = nativeImage.createFromBitmap(diffBitmap, { width, height, scaleFactor: 1 }).toPNG();
    if (png.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "Browser visual diff exceeds the result size limit");
    }
    diff = {
      tabId: left.tabId,
      mime: "image/png",
      base64: png.toString("base64"),
      width,
      height,
      mode: left.mode,
      generation: left.generation,
      untrustedWebContent: true,
    };
  }
  return {
    mode: left.mode,
    width,
    height,
    dimensionsMatch: true,
    differentPixels,
    totalPixels,
    differenceRatio: differentPixels / totalPixels,
    regions: differentPixels === 0 ? [] : [{ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }],
    leftGeneration: left.generation,
    rightGeneration: right.generation,
    ...(diff ? { diff } : {}),
    untrustedWebContent: true,
  };
}
