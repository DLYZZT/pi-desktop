import type { Rectangle } from "electron";
import {
  BROWSER_DEVICE_LIMITS,
  BROWSER_DEVICE_PRESETS,
  type BrowserDeviceMode,
  type BrowserDevicePresetId,
} from "../../contract/browser-device.ts";
import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";

export const BROWSER_DEVICE_KEEP = "browser-device";

export function resolveBrowserDevice(input: unknown, current: BrowserDeviceMode): BrowserDeviceMode {
  const invalid = () => new BrowserError("INVALID_BROWSER_REQUEST", "Browser device configuration is invalid");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const { mode, presetId, width, height, dpr, orientation, touch } = input as Record<string, unknown>;
  if (mode === "desktop") return { mode };
  if (mode === "rotate") {
    if (current.mode !== "mobile") throw invalid();
    return {
      ...current,
      width: current.height,
      height: current.width,
      orientation: current.orientation === "portrait" ? "landscape" : "portrait",
    };
  }
  if (orientation !== undefined && orientation !== "portrait" && orientation !== "landscape") throw invalid();
  if (touch !== undefined && typeof touch !== "boolean") throw invalid();
  const limits = BROWSER_DEVICE_LIMITS;
  let size: { width: number; height: number; dpr: number };
  let id: BrowserDevicePresetId | null = null;
  if (mode === "preset" && typeof presetId === "string" && Object.hasOwn(BROWSER_DEVICE_PRESETS, presetId)) {
    id = presetId as BrowserDevicePresetId;
    const preset = BROWSER_DEVICE_PRESETS[id];
    size = { width: preset.width, height: preset.height, dpr: preset.dpr };
  } else if (
    mode === "custom" &&
    typeof width === "number" &&
    typeof height === "number" &&
    typeof dpr === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= limits.minSize &&
    width <= limits.maxSize &&
    height >= limits.minSize &&
    height <= limits.maxSize &&
    Number.isFinite(dpr) &&
    dpr >= limits.minDpr &&
    dpr <= limits.maxDpr
  ) {
    size = { width, height, dpr };
  } else {
    throw invalid();
  }
  const direction = orientation ?? (size.width > size.height ? "landscape" : "portrait");
  if (
    (direction === "landscape" && size.width < size.height) ||
    (direction === "portrait" && size.width > size.height)
  ) {
    [size.width, size.height] = [size.height, size.width];
  }
  return { mode: "mobile", presetId: id, ...size, orientation: direction, touch: touch ?? true };
}

export function browserDevicePresentation(device: BrowserDeviceMode, bounds: Rectangle | undefined) {
  if (!bounds || device.mode === "desktop") return { bounds, scale: 1 };
  const scale = Math.min(1, bounds.width / device.width, bounds.height / device.height);
  const width = Math.max(1, Math.floor(device.width * scale));
  const height = Math.max(1, Math.floor(device.height * scale));
  return {
    bounds: {
      x: bounds.x + Math.floor((bounds.width - width) / 2),
      y: bounds.y + Math.floor((bounds.height - height) / 2),
      width,
      height,
    },
    scale,
  };
}

export async function applyBrowserDevice(
  cdp: Pick<BrowserCdpCoordinator, "sendCommand" | "keepAttached">,
  tabId: string,
  device: BrowserDeviceMode,
  scale: number,
): Promise<void> {
  cdp.keepAttached(tabId, BROWSER_DEVICE_KEEP);
  await applyBrowserDeviceMetrics(cdp, tabId, device, scale);
}

async function applyBrowserDeviceInput(
  cdp: Pick<BrowserCdpCoordinator, "sendCommand">,
  tabId: string,
  device: BrowserDeviceMode,
): Promise<void> {
  const enabled = device.mode === "mobile" && device.touch;
  // Disable mouse conversion first: it also changes Chromium's touch preferences.
  await cdp.sendCommand(tabId, "Emulation.setEmitTouchEventsForMouse", {
    enabled,
    configuration: device.mode === "mobile" ? "mobile" : "desktop",
  });
  await cdp.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
    enabled,
    ...(enabled ? { maxTouchPoints: 5 } : {}),
  });
}

export async function applyBrowserDeviceMetrics(
  cdp: Pick<BrowserCdpCoordinator, "sendCommand">,
  tabId: string,
  device: BrowserDeviceMode,
  scale: number,
): Promise<void> {
  if (device.mode === "desktop") {
    await cdp.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride");
  } else {
    const landscape = device.orientation === "landscape";
    await cdp.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      mobile: true,
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      screenWidth: device.width,
      screenHeight: device.height,
      scale,
      screenOrientation: { type: landscape ? "landscapePrimary" : "portraitPrimary", angle: landscape ? 90 : 0 },
    });
  }
  // Applying metrics makes Chromium reconfigure the rendered widget, which can
  // drop the touch-emulation state applied earlier, so re-assert it every time.
  await applyBrowserDeviceInput(cdp, tabId, device);
}

export function releaseBrowserDevice(cdp: Pick<BrowserCdpCoordinator, "releaseKeep">, tabId: string): void {
  cdp.releaseKeep(tabId, BROWSER_DEVICE_KEEP);
}
