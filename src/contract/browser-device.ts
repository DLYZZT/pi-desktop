export const BROWSER_DEVICE_PRESETS = {
  "galaxy-a55": { label: "Samsung Galaxy A55", width: 360, height: 800, dpr: 3 },
  "pixel-7": { label: "Google Pixel 7", width: 412, height: 915, dpr: 2.625 },
  "iphone-14": { label: "iPhone 14", width: 390, height: 844, dpr: 3 },
} as const;

export const BROWSER_DEVICE_LIMITS = { minSize: 200, maxSize: 2048, minDpr: 1, maxDpr: 4 } as const;

export type BrowserDevicePresetId = keyof typeof BROWSER_DEVICE_PRESETS;
export type BrowserDeviceOrientation = "portrait" | "landscape";

export type BrowserDeviceModeInput =
  | { mode: "desktop" }
  | { mode: "preset"; presetId: BrowserDevicePresetId; orientation?: BrowserDeviceOrientation; touch?: boolean }
  | {
      mode: "custom";
      width: number;
      height: number;
      dpr: number;
      orientation?: BrowserDeviceOrientation;
      touch?: boolean;
    }
  | { mode: "rotate" };

export type BrowserDeviceMode =
  | { mode: "desktop" }
  | {
      mode: "mobile";
      presetId: BrowserDevicePresetId | null;
      width: number;
      height: number;
      dpr: number;
      orientation: BrowserDeviceOrientation;
      touch: boolean;
    };
