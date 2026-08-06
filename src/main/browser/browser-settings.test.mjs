import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyBrowserSettingsPatch,
  createDefaultBrowserSettings,
  parseBrowserSettings,
  settingsForPersistence,
  validateBrowserSettings,
} from "./browser-settings.ts";
import { BrowserSettingsStore } from "./browser-settings-store.ts";

test("browser defaults are usable for local browsing and fail closed for automation and advanced capabilities", () => {
  const settings = createDefaultBrowserSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.navigation.allowHttp, false);
  assert.equal(settings.navigation.allowPrivateNetwork, false);
  assert.equal(settings.navigation.networkIsolation, "best-effort");
  assert.equal(settings.automation.enabled, false);
  assert.equal(settings.automation.defaultPermission, "ask");
  assert.equal(settings.version, 3);
  assert.equal(settings.advancedBrowserMode.enabled, false);
  assert.equal(settings.advancedBrowserMode.persistence, "this-launch");
  assert.equal(settings.advancedBrowserMode.identityMode, "chrome-compatible");
});

test("browser settings reject unknown fields, invalid ranges, unsafe URLs, and incomplete custom identities", () => {
  const defaults = createDefaultBrowserSettings();
  assert.throws(() => validateBrowserSettings({ ...defaults, surprise: true }), /not supported/);
  assert.throws(
    () => validateBrowserSettings({ ...defaults, navigation: { ...defaults.navigation, maxTabs: 0 } }),
    /navigation.maxTabs/,
  );
  assert.throws(
    () => validateBrowserSettings({ ...defaults, navigation: { ...defaults.navigation, homepage: "file:///tmp/a" } }),
    /unsupported protocol/,
  );
  assert.throws(
    () =>
      validateBrowserSettings({
        ...defaults,
        advancedBrowserMode: {
          ...defaults.advancedBrowserMode,
          identityMode: "custom",
          customUserAgentValue: "Chrome/142.0.0.0",
        },
      }),
    /requires UA, platform, and full version/,
  );
});

test("patches preserve unrelated settings and launch-only advanced mode is removed before persistence", () => {
  const settings = applyBrowserSettingsPatch(createDefaultBrowserSettings(), {
    automation: { enabled: true, defaultPermission: "interact" },
    advancedBrowserMode: {
      enabled: true,
      persistence: "this-launch",
    },
  });
  assert.equal(settings.automation.enabled, true);
  assert.equal(settings.navigation.homepage, "about:blank");
  assert.equal(settings.advancedBrowserMode.enabled, true);
  const persisted = settingsForPersistence(settings);
  assert.equal(persisted.advancedBrowserMode.enabled, false);
  assert.equal(persisted.advancedBrowserMode.identityMode, "chrome-compatible");
});

test("invalid settings recover to safe defaults while a future schema is read-only", () => {
  const invalid = parseBrowserSettings({ version: 3, enabled: true });
  assert.equal(invalid.recoveredFromInvalid, true);
  assert.equal(invalid.settings.automation.enabled, false);
  assert.equal(invalid.settings.advancedBrowserMode.enabled, false);

  const future = parseBrowserSettings({ version: 99, future: true });
  assert.equal(future.compatibilityReadOnly, true);
  assert.equal(future.recoveredFromInvalid, false);
  assert.equal(future.settings.enabled, true);
  assert.equal(future.settings.automation.enabled, false);
});

test("v1 settings migrate configuration drafts but never migrate an active advanced grant", () => {
  const defaults = createDefaultBrowserSettings();
  const legacy = {
    ...defaults,
    version: 1,
    advanced: {
      enabled: true,
      persistence: "persistent",
      arbitraryJavaScript: true,
      cookieAccess: "all-profile",
      cookieMutation: false,
      requestHeaderOverrides: true,
      responseHeaderOverrides: true,
      customUserAgent: true,
      customUserAgentValue:
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.1.2 Safari/537.36",
      customUserAgentPlatform: "macOS",
      cdpAllowedMethods: ["Runtime.evaluate"],
      allowApprovedChannelSessions: true,
    },
  };
  delete legacy.advancedBrowserMode;
  const migrated = parseBrowserSettings(legacy);
  assert.equal(migrated.recoveredFromInvalid, false);
  assert.equal(migrated.settings.version, 3);
  assert.equal(migrated.settings.automation.defaultPermission, "ask");
  assert.equal(migrated.settings.advancedBrowserMode.enabled, false);
  assert.equal(migrated.settings.advancedBrowserMode.identityMode, "custom");
  assert.equal(migrated.settings.advancedBrowserMode.customUserAgentFullVersion, "142.0.1.2");
});

test("v2 automation defaults always migrate to ask and active advanced state is discarded", () => {
  const legacy = createDefaultBrowserSettings();
  legacy.version = 2;
  legacy.automation.defaultPermission = "interact";
  legacy.advancedBrowserMode.enabled = true;
  const migrated = parseBrowserSettings(legacy);
  assert.equal(migrated.recoveredFromInvalid, false);
  assert.equal(migrated.settings.version, 3);
  assert.equal(migrated.settings.automation.defaultPermission, "ask");
  assert.equal(migrated.settings.advancedBrowserMode.enabled, false);
});

test("BrowserSettingsStore writes atomically with private mode, recovers corruption, and preserves future state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-settings-"));
  const file = path.join(directory, "browser-settings.json");
  try {
    const store = new BrowserSettingsStore(file);
    assert.equal(store.get().settings.automation.enabled, false);
    const updated = store.update({ automation: { enabled: true, defaultPermission: "read" } });
    assert.equal(updated.settings.automation.enabled, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).automation.enabled, true);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    writeFileSync(file, "{broken", "utf8");
    const recovered = store.reload();
    assert.equal(recovered.recoveredFromInvalid, true);
    assert.equal(recovered.settings.automation.enabled, false);

    const futureText = `${JSON.stringify({ version: 42, future: true })}\n`;
    writeFileSync(file, futureText, "utf8");
    const future = store.reload();
    assert.equal(future.compatibilityReadOnly, true);
    assert.throws(() => store.update({ enabled: false }), /newer Pi Desktop/);
    assert.equal(readFileSync(file, "utf8"), futureText);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
