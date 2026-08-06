import {
  BROWSER_SETTINGS_VERSION,
  type BrowserAdvancedBrowserModeSettings,
  type BrowserAutomationSettings,
  type BrowserDownloadSettings,
  type BrowserNavigationSettings,
  type BrowserPanelSettings,
  type BrowserProxySettings,
  type BrowserSettingsPatch,
  type BrowserSettingsV2,
} from "../../contract/browser.ts";

const OBJECT_KEYS = new Set([
  "enabled",
  "panel",
  "navigation",
  "automation",
  "downloads",
  "proxy",
  "advancedBrowserMode",
]);
const PANEL_KEYS = new Set<keyof BrowserPanelSettings>([
  "openOnAgentUse",
  "browserWidth",
  "restoreTabs",
  "defaultProfileId",
  "saveLoginState",
]);
const NAVIGATION_KEYS = new Set<keyof BrowserNavigationSettings>([
  "homepage",
  "maxTabs",
  "maxTabsPerSession",
  "navigationTimeoutMs",
  "actionTimeoutMs",
  "allowHttp",
  "allowPrivateNetwork",
  "networkIsolation",
]);
const AUTOMATION_KEYS = new Set<keyof BrowserAutomationSettings>([
  "enabled",
  "defaultPermission",
  "sensitiveActions",
  "userTakeover",
  "allowChannelSessions",
  "showActionHighlight",
]);
const DOWNLOAD_KEYS = new Set<keyof BrowserDownloadSettings>(["mode", "directory"]);
const PROXY_KEYS = new Set<keyof BrowserProxySettings>([
  "mode",
  "proxyRules",
  "proxyBypassRules",
  "credentialSecretRef",
]);
const ADVANCED_MODE_KEYS = new Set<keyof BrowserAdvancedBrowserModeSettings>([
  "enabled",
  "persistence",
  "identityMode",
  "customUserAgentValue",
  "customUserAgentPlatform",
  "customUserAgentFullVersion",
  "certificateBypassDomains",
  "maxRequestsPerTab",
  "maxBodyBytesPerTab",
  "maxPerHost",
]);

export interface ParsedBrowserSettings {
  settings: BrowserSettingsV2;
  compatibilityReadOnly: boolean;
  recoveredFromInvalid: boolean;
}

export function createDefaultBrowserSettings(): BrowserSettingsV2 {
  return {
    version: BROWSER_SETTINGS_VERSION,
    enabled: true,
    panel: {
      openOnAgentUse: true,
      browserWidth: 520,
      restoreTabs: false,
      defaultProfileId: "temporary",
      saveLoginState: false,
    },
    navigation: {
      homepage: "about:blank",
      maxTabs: 12,
      maxTabsPerSession: 4,
      navigationTimeoutMs: 30_000,
      actionTimeoutMs: 15_000,
      allowHttp: false,
      allowPrivateNetwork: false,
      networkIsolation: "best-effort",
    },
    automation: {
      enabled: false,
      defaultPermission: "ask",
      sensitiveActions: "always-ask",
      userTakeover: "cancel-agent-action",
      allowChannelSessions: false,
      showActionHighlight: true,
    },
    downloads: {
      mode: "ask",
    },
    proxy: {
      mode: "system",
    },
    advancedBrowserMode: {
      enabled: false,
      persistence: "this-launch",
      identityMode: "chrome-compatible",
      customUserAgentValue: "",
      customUserAgentPlatform: "",
      customUserAgentFullVersion: "",
      certificateBypassDomains: [],
      maxRequestsPerTab: 500,
      maxBodyBytesPerTab: 16 * 1024 * 1024,
      maxPerHost: 40,
    },
  };
}

export function parseBrowserSettings(value: unknown): ParsedBrowserSettings {
  if (isRecord(value) && typeof value.version === "number" && value.version > BROWSER_SETTINGS_VERSION) {
    return {
      settings: createDefaultBrowserSettings(),
      compatibilityReadOnly: true,
      recoveredFromInvalid: false,
    };
  }
  try {
    if (isRecord(value) && value.version === 1) {
      return {
        settings: migrateBrowserSettingsV1(value),
        compatibilityReadOnly: false,
        recoveredFromInvalid: false,
      };
    }
    if (isRecord(value) && value.version === 2) {
      return {
        settings: migrateBrowserSettingsV2(value),
        compatibilityReadOnly: false,
        recoveredFromInvalid: false,
      };
    }
    return {
      settings: validateBrowserSettings(value),
      compatibilityReadOnly: false,
      recoveredFromInvalid: false,
    };
  } catch {
    return {
      settings: createDefaultBrowserSettings(),
      compatibilityReadOnly: false,
      recoveredFromInvalid: true,
    };
  }
}

function migrateBrowserSettingsV1(value: Record<string, unknown>): BrowserSettingsV2 {
  const root = expectRecord(value, "Browser settings v1");
  expectExactKeys(
    root,
    new Set(["version", "enabled", "panel", "navigation", "automation", "downloads", "proxy", "advanced"]),
    "Browser settings v1",
  );
  const advanced = expectRecord(root.advanced, "Browser settings v1 advanced");
  const customUserAgentValue =
    typeof advanced.customUserAgentValue === "string" ? advanced.customUserAgentValue.slice(0, 1_024) : "";
  const customUserAgentPlatform =
    typeof advanced.customUserAgentPlatform === "string" ? advanced.customUserAgentPlatform.slice(0, 128) : "";
  const fullVersion = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(customUserAgentValue)?.[1] ?? "";
  const defaults = createDefaultBrowserSettings();
  return validateBrowserSettings({
    version: BROWSER_SETTINGS_VERSION,
    enabled: root.enabled,
    panel: root.panel,
    navigation: root.navigation,
    automation: {
      ...expectRecord(root.automation, "Browser settings v1 automation"),
      // v1/v2 had no provenance for this implicit grant. Never carry it forward.
      defaultPermission: "ask",
    },
    downloads: root.downloads,
    proxy: root.proxy,
    advancedBrowserMode: {
      ...defaults.advancedBrowserMode,
      // A legacy grant is never trusted across migration or application restart.
      enabled: false,
      identityMode:
        advanced.customUserAgent === true && customUserAgentValue && customUserAgentPlatform && fullVersion
          ? "custom"
          : "chrome-compatible",
      customUserAgentValue,
      customUserAgentPlatform,
      customUserAgentFullVersion: fullVersion,
    },
  });
}

function migrateBrowserSettingsV2(value: Record<string, unknown>): BrowserSettingsV2 {
  const root = expectRecord(value, "Browser settings v2");
  expectExactKeys(root, new Set(["version", ...OBJECT_KEYS]), "Browser settings v2");
  const defaults = createDefaultBrowserSettings();
  return validateBrowserSettings({
    ...root,
    version: BROWSER_SETTINGS_VERSION,
    automation: {
      ...expectRecord(root.automation, "Browser settings v2 automation"),
      // v2's none/read/interact default was an eager runtime grant, not an
      // explicit durable decision, so every migration fails closed to ask.
      defaultPermission: "ask",
    },
    advancedBrowserMode: {
      ...defaults.advancedBrowserMode,
      ...expectRecord(root.advancedBrowserMode, "Browser settings v2 advanced mode"),
      enabled: false,
    },
  });
}

export function validateBrowserSettings(value: unknown): BrowserSettingsV2 {
  const root = expectRecord(value, "Browser settings");
  expectExactKeys(root, new Set(["version", ...OBJECT_KEYS]), "Browser settings");
  if (root.version !== BROWSER_SETTINGS_VERSION) throw new Error("Unsupported Browser settings version");

  const panel = expectRecord(root.panel, "Browser panel settings");
  expectExactKeys(panel, PANEL_KEYS, "Browser panel settings");
  const navigation = expectRecord(root.navigation, "Browser navigation settings");
  expectExactKeys(navigation, NAVIGATION_KEYS, "Browser navigation settings");
  const automation = expectRecord(root.automation, "Browser automation settings");
  expectExactKeys(automation, AUTOMATION_KEYS, "Browser automation settings");
  const downloads = expectRecord(root.downloads, "Browser download settings");
  expectExactKeys(downloads, DOWNLOAD_KEYS, "Browser download settings", true);
  const proxy = expectRecord(root.proxy, "Browser proxy settings");
  expectExactKeys(proxy, PROXY_KEYS, "Browser proxy settings", true);
  const advancedMode = expectRecord(root.advancedBrowserMode, "Browser advanced mode settings");
  expectExactKeys(advancedMode, ADVANCED_MODE_KEYS, "Browser advanced mode settings");

  const settings: BrowserSettingsV2 = {
    version: BROWSER_SETTINGS_VERSION,
    enabled: expectBoolean(root.enabled, "enabled"),
    panel: {
      openOnAgentUse: expectBoolean(panel.openOnAgentUse, "panel.openOnAgentUse"),
      browserWidth: expectInteger(panel.browserWidth, 280, 4_096, "panel.browserWidth"),
      restoreTabs: expectBoolean(panel.restoreTabs, "panel.restoreTabs"),
      defaultProfileId: expectSafeIdentifier(panel.defaultProfileId, "panel.defaultProfileId"),
      saveLoginState: expectBoolean(panel.saveLoginState, "panel.saveLoginState"),
    },
    navigation: {
      homepage: validateHomepage(expectString(navigation.homepage, 2_048, "navigation.homepage")),
      maxTabs: expectInteger(navigation.maxTabs, 1, 64, "navigation.maxTabs"),
      maxTabsPerSession: expectInteger(navigation.maxTabsPerSession, 1, 32, "navigation.maxTabsPerSession"),
      navigationTimeoutMs: expectInteger(
        navigation.navigationTimeoutMs,
        1_000,
        300_000,
        "navigation.navigationTimeoutMs",
      ),
      actionTimeoutMs: expectInteger(navigation.actionTimeoutMs, 250, 120_000, "navigation.actionTimeoutMs"),
      allowHttp: expectBoolean(navigation.allowHttp, "navigation.allowHttp"),
      allowPrivateNetwork: expectBoolean(navigation.allowPrivateNetwork, "navigation.allowPrivateNetwork"),
      networkIsolation: expectEnum(
        navigation.networkIsolation,
        ["best-effort", "strict"] as const,
        "navigation.networkIsolation",
      ),
    },
    automation: {
      enabled: expectBoolean(automation.enabled, "automation.enabled"),
      defaultPermission: expectEnum(
        automation.defaultPermission,
        ["ask", "deny", "read", "interact"] as const,
        "automation.defaultPermission",
      ),
      sensitiveActions: expectEnum(
        automation.sensitiveActions,
        ["always-ask", "deny"] as const,
        "automation.sensitiveActions",
      ),
      userTakeover: expectEnum(
        automation.userTakeover,
        ["cancel-agent-action", "wait"] as const,
        "automation.userTakeover",
      ),
      allowChannelSessions: expectBoolean(automation.allowChannelSessions, "automation.allowChannelSessions"),
      showActionHighlight: expectBoolean(automation.showActionHighlight, "automation.showActionHighlight"),
    },
    downloads: {
      mode: expectEnum(downloads.mode, ["ask", "deny", "allow-to-directory"] as const, "downloads.mode"),
      ...(downloads.directory === undefined
        ? {}
        : { directory: expectString(downloads.directory, 4_096, "downloads.directory") }),
    },
    proxy: {
      mode: expectEnum(proxy.mode, ["system", "direct", "custom"] as const, "proxy.mode"),
      ...(proxy.proxyRules === undefined
        ? {}
        : { proxyRules: expectSafeSingleLine(proxy.proxyRules, 4_096, "proxy.proxyRules") }),
      ...(proxy.proxyBypassRules === undefined
        ? {}
        : { proxyBypassRules: expectSafeSingleLine(proxy.proxyBypassRules, 4_096, "proxy.proxyBypassRules") }),
      ...(proxy.credentialSecretRef === undefined
        ? {}
        : {
            credentialSecretRef: expectSafeSingleLine(proxy.credentialSecretRef, 256, "proxy.credentialSecretRef"),
          }),
    },
    advancedBrowserMode: {
      enabled: expectBoolean(advancedMode.enabled, "advancedBrowserMode.enabled"),
      persistence: expectEnum(advancedMode.persistence, ["this-launch"] as const, "advancedBrowserMode.persistence"),
      identityMode: expectEnum(
        advancedMode.identityMode,
        ["native", "chrome-compatible", "custom"] as const,
        "advancedBrowserMode.identityMode",
      ),
      customUserAgentValue: expectSafeSingleLine(
        advancedMode.customUserAgentValue,
        1_024,
        "advancedBrowserMode.customUserAgentValue",
        true,
      ),
      customUserAgentPlatform: expectSafeSingleLine(
        advancedMode.customUserAgentPlatform,
        128,
        "advancedBrowserMode.customUserAgentPlatform",
        true,
      ),
      customUserAgentFullVersion: expectSafeSingleLine(
        advancedMode.customUserAgentFullVersion,
        128,
        "advancedBrowserMode.customUserAgentFullVersion",
        true,
      ),
      certificateBypassDomains: validateDomains(advancedMode.certificateBypassDomains),
      maxRequestsPerTab: expectInteger(
        advancedMode.maxRequestsPerTab,
        50,
        5_000,
        "advancedBrowserMode.maxRequestsPerTab",
      ),
      maxBodyBytesPerTab: expectInteger(
        advancedMode.maxBodyBytesPerTab,
        1024 * 1024,
        256 * 1024 * 1024,
        "advancedBrowserMode.maxBodyBytesPerTab",
      ),
      maxPerHost: expectInteger(advancedMode.maxPerHost, 5, 200, "advancedBrowserMode.maxPerHost"),
    },
  };

  if (settings.navigation.maxTabsPerSession > settings.navigation.maxTabs) {
    throw new Error("navigation.maxTabsPerSession cannot exceed navigation.maxTabs");
  }
  if (settings.downloads.mode === "allow-to-directory" && !settings.downloads.directory) {
    throw new Error("downloads.directory is required when automatic download is enabled");
  }
  if (settings.proxy.mode === "custom" && !settings.proxy.proxyRules) {
    throw new Error("proxy.proxyRules is required for custom proxy mode");
  }
  if (settings.advancedBrowserMode.identityMode === "custom") {
    if (
      !settings.advancedBrowserMode.customUserAgentValue ||
      !settings.advancedBrowserMode.customUserAgentPlatform ||
      !settings.advancedBrowserMode.customUserAgentFullVersion
    ) {
      throw new Error("Custom Browser identity requires UA, platform, and full version");
    }
  }
  return settings;
}

export function validateBrowserSettingsPatch(value: unknown): BrowserSettingsPatch {
  const patch = expectRecord(value, "Browser settings patch");
  expectAllowedKeys(patch, OBJECT_KEYS, "Browser settings patch");
  validatePartialObject(patch.panel, PANEL_KEYS, "panel");
  validatePartialObject(patch.navigation, NAVIGATION_KEYS, "navigation");
  validatePartialObject(patch.automation, AUTOMATION_KEYS, "automation");
  validatePartialObject(patch.downloads, DOWNLOAD_KEYS, "downloads");
  validatePartialObject(patch.proxy, PROXY_KEYS, "proxy");
  validatePartialObject(patch.advancedBrowserMode, ADVANCED_MODE_KEYS, "advancedBrowserMode");
  return structuredClone(patch) as BrowserSettingsPatch;
}

export function applyBrowserSettingsPatch(current: BrowserSettingsV2, patchValue: unknown): BrowserSettingsV2 {
  const patch = validateBrowserSettingsPatch(patchValue);
  return validateBrowserSettings({
    ...current,
    ...patch,
    version: BROWSER_SETTINGS_VERSION,
    panel: { ...current.panel, ...patch.panel },
    navigation: { ...current.navigation, ...patch.navigation },
    automation: { ...current.automation, ...patch.automation },
    downloads: { ...current.downloads, ...patch.downloads },
    proxy: { ...current.proxy, ...patch.proxy },
    advancedBrowserMode: { ...current.advancedBrowserMode, ...patch.advancedBrowserMode },
  });
}

export function settingsForPersistence(settings: BrowserSettingsV2): BrowserSettingsV2 {
  const output = structuredClone(settings);
  output.advancedBrowserMode.enabled = false;
  return output;
}

function validateHomepage(value: string): string {
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("navigation.homepage must be an absolute URL or about:blank");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("navigation.homepage uses an unsupported protocol");
  }
  if (url.username || url.password) throw new Error("navigation.homepage must not contain credentials");
  return url.toString();
}

function validateDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("advancedBrowserMode.certificateBypassDomains is invalid");
  }
  const domains = value.map((domain) =>
    expectSafeSingleLine(domain, 253, "advancedBrowserMode.certificateBypassDomains[]"),
  );
  if (
    domains.some(
      (domain) =>
        domain.startsWith(".") ||
        domain.endsWith(".") ||
        !domain
          .toLowerCase()
          .split(".")
          .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
    )
  ) {
    throw new Error("advancedBrowserMode.certificateBypassDomains contains an invalid hostname");
  }
  return [...new Set(domains.map((domain) => domain.toLowerCase()))].sort();
}

function validatePartialObject(value: unknown, allowed: ReadonlySet<PropertyKey>, label: string): void {
  if (value === undefined) return;
  expectAllowedKeys(expectRecord(value, label), allowed, label);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function expectExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<PropertyKey>,
  label: string,
  optionalKeys = false,
): void {
  expectAllowedKeys(value, allowed, label);
  if (!optionalKeys) {
    for (const key of allowed) {
      if (typeof key === "string" && !(key in value)) throw new Error(`${label}.${key} is required`);
    }
  }
}

function expectAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<PropertyKey>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function expectString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function expectSafeSingleLine(value: unknown, maxLength: number, label: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  const stringValue = expectString(value, maxLength, label);
  if (/[\r\n]/.test(stringValue)) throw new Error(`${label} must be a single line`);
  return stringValue;
}

function expectSafeIdentifier(value: unknown, label: string): string {
  const stringValue = expectString(value, 128, label);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(stringValue)) throw new Error(`${label} is invalid`);
  return stringValue;
}

function expectInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function expectEnum<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}
