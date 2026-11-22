import os from "node:os";
import type { Session, WebContents } from "electron";
import type { BrowserAdvancedBrowserModeSettings, BrowserIdentityProfile } from "../../contract/browser.ts";
import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";

const IDENTITY_KEEP_REASON = "browser-identity";

export class BrowserIdentityManager {
  private readonly cdp: BrowserCdpCoordinator;

  constructor(cdp: BrowserCdpCoordinator) {
    this.cdp = cdp;
  }

  buildProfile(
    settings: BrowserAdvancedBrowserModeSettings,
    nativeUserAgent: string,
    acceptLanguage = "en-US,en",
  ): BrowserIdentityProfile {
    const platform = platformName();
    const nativeVersion = extractChromiumVersion(nativeUserAgent) ?? process.versions.chrome ?? "0.0.0.0";
    if (settings.identityMode === "native") {
      return profileFor(nativeUserAgent, nativeVersion, platform, acceptLanguage, "native");
    }
    if (settings.identityMode === "custom") {
      if (!settings.customUserAgentValue || !settings.customUserAgentPlatform || !settings.customUserAgentFullVersion) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Custom Browser identity is incomplete");
      }
      const uaVersion = extractChromiumVersion(settings.customUserAgentValue);
      if (!uaVersion || uaVersion.split(".")[0] !== settings.customUserAgentFullVersion.split(".")[0]) {
        throw new BrowserError(
          "INVALID_BROWSER_REQUEST",
          "Custom Browser User-Agent and Client Hints Chromium versions do not match",
        );
      }
      return profileFor(
        settings.customUserAgentValue,
        settings.customUserAgentFullVersion,
        settings.customUserAgentPlatform,
        acceptLanguage,
        "custom",
      );
    }
    const chromiumUa = nativeUserAgent
      .replace(/\sElectron\/[^\s]+/gi, "")
      .replace(/\sPi(?:Agent)?Desktop\/[^\s]+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return profileFor(chromiumUa, nativeVersion, platform, acceptLanguage, "chrome-compatible");
  }

  async apply(
    tabId: string,
    contents: WebContents,
    browserSession: Session,
    profile: BrowserIdentityProfile,
  ): Promise<void> {
    contents.setUserAgent(profile.ua);
    browserSession.setUserAgent(profile.ua, profile.acceptLanguage);
    if (profile.mode === "native") {
      this.cdp.releaseKeep(tabId, IDENTITY_KEEP_REASON);
      return;
    }
    this.cdp.keepAttached(tabId, IDENTITY_KEEP_REASON);
    await this.applyTabOverride(tabId, profile);
  }

  mobileProfile(
    nativeUserAgent: string,
    platform: "Android" | "iOS",
    acceptLanguage = "en-US,en",
  ): BrowserIdentityProfile {
    const version = extractChromiumVersion(nativeUserAgent) ?? process.versions.chrome ?? "0.0.0.0";
    const android = platform === "Android";
    const ua = android
      ? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split(".")[0]}.0.0.0 Mobile Safari/537.36`
      : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    return {
      ...profileFor(ua, version, platform, acceptLanguage, "chrome-compatible"),
      platformVersion: android ? "10.0.0" : "17.0.0",
      architecture: "arm",
      bitness: "64",
      model: android ? "" : "iPhone",
    };
  }

  async applyTabOverride(tabId: string, profile?: BrowserIdentityProfile): Promise<void> {
    if (!profile || profile.mode === "native") {
      await this.cdp.sendCommand(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
      return;
    }
    await this.cdp.sendCommand(tabId, "Emulation.setUserAgentOverride", {
      userAgent: profile.ua,
      acceptLanguage: profile.acceptLanguage,
      platform: profile.platform,
      userAgentMetadata: {
        brands: profile.brands,
        fullVersionList: profile.fullVersionList,
        fullVersion: profile.fullVersionList[0]?.version ?? "",
        platform: profile.platform,
        platformVersion: profile.platformVersion,
        architecture: profile.architecture,
        model: profile.model,
        mobile: profile.mobile,
        bitness: profile.bitness,
        wow64: profile.wow64,
      },
    });
  }

  async clear(tabId: string, contents: WebContents, browserSession: Session, nativeUserAgent: string): Promise<void> {
    contents.setUserAgent(nativeUserAgent);
    browserSession.setUserAgent(nativeUserAgent);
    try {
      if (this.cdp.isAttached(tabId)) await this.applyTabOverride(tabId);
    } finally {
      this.cdp.releaseKeep(tabId, IDENTITY_KEEP_REASON);
    }
  }
}

function profileFor(
  ua: string,
  fullVersion: string,
  platform: string,
  acceptLanguage: string,
  mode: BrowserIdentityProfile["mode"],
): BrowserIdentityProfile {
  const normalizedVersion = normalizeVersion(fullVersion);
  const major = normalizedVersion.split(".")[0] ?? "0";
  const chromiumBrand = { brand: "Chromium", version: major };
  const fullChromiumBrand = { brand: "Chromium", version: normalizedVersion };
  const useChromeBrand = /\bChrome\//.test(ua);
  const architecture = architectureFromUserAgent(ua);
  return {
    mode,
    ua,
    acceptLanguage,
    platform,
    brands: [
      chromiumBrand,
      ...(useChromeBrand ? [{ brand: "Google Chrome", version: major }] : []),
      { brand: "Not_A Brand", version: "99" },
    ],
    fullVersionList: [
      fullChromiumBrand,
      ...(useChromeBrand ? [{ brand: "Google Chrome", version: normalizedVersion }] : []),
      { brand: "Not_A Brand", version: "99.0.0.0" },
    ],
    platformVersion: platformVersion(platform),
    architecture: architecture.name,
    model: "",
    mobile: /\bMobile\b/i.test(ua),
    bitness: architecture.bitness,
    wow64: false,
  };
}

function normalizeVersion(value: string): string {
  const parts = value.match(/\d+/g)?.slice(0, 4) ?? ["0"];
  while (parts.length < 4) parts.push("0");
  return parts.join(".");
}

function extractChromiumVersion(userAgent: string): string | undefined {
  return /(?:Chrome|Chromium)\/([0-9.]+)/.exec(userAgent)?.[1];
}

function platformName(): string {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

function platformVersion(platform: string): string {
  if (platform === "macOS") {
    if (process.platform !== "darwin") return "10.15.7";
    const darwinMajor = Number.parseInt(os.release().split(".")[0] ?? "", 10);
    if (Number.isFinite(darwinMajor) && darwinMajor >= 20) return `${darwinMajor - 9}.0.0`;
  }
  if (platform === "Windows") {
    return process.platform === "win32"
      ? os
          .release()
          .replace(/[^0-9.].*$/, "")
          .slice(0, 64)
      : "10.0.0";
  }
  if (platform === "Linux") {
    return process.platform === "linux"
      ? os
          .release()
          .replace(/[^0-9.].*$/, "")
          .slice(0, 64)
      : "0.0.0";
  }
  return "0.0.0";
}

function architectureFromUserAgent(ua: string): { name: string; bitness: string } {
  if (/\b(?:arm64|aarch64)\b/i.test(ua)) return { name: "arm", bitness: "64" };
  if (/\b(?:x86_64|x64|amd64|Win64)\b/i.test(ua)) return { name: "x86", bitness: "64" };
  if (/\b(?:i[3-6]86|x86)\b/i.test(ua)) return { name: "x86", bitness: "32" };
  return {
    name: process.arch === "arm64" ? "arm" : process.arch === "x64" ? "x86" : process.arch,
    bitness: process.arch === "x64" || process.arch === "arm64" ? "64" : "32",
  };
}
