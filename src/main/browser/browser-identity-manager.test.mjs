import assert from "node:assert/strict";
import test from "node:test";

import { BrowserIdentityManager } from "./browser-identity-manager.ts";
import { applyIdentityHeaders } from "./browser-network-interceptor.ts";
import { createDefaultBrowserSettings } from "./browser-settings.ts";

class FakeCdp {
  commands = [];
  keepReasons = [];

  keepAttached(tabId, reason) {
    this.keepReasons.push({ tabId, reason });
    return () => undefined;
  }

  releaseKeep(tabId, reason) {
    this.keepReasons = this.keepReasons.filter((entry) => entry.tabId !== tabId || entry.reason !== reason);
  }

  async sendCommand(tabId, method, params) {
    this.commands.push({ tabId, method, params });
    return {};
  }
}

function customSettings() {
  const settings = createDefaultBrowserSettings().advancedBrowserMode;
  return {
    ...settings,
    enabled: true,
    identityMode: "custom",
    customUserAgentValue:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    customUserAgentPlatform: "FixtureOS",
    customUserAgentFullVersion: "142.0.0.0",
  };
}

test("identity profile drives Chromium UA metadata and network Client Hints from one source", async () => {
  const cdp = new FakeCdp();
  const manager = new BrowserIdentityManager(cdp);
  const profile = manager.buildProfile(customSettings(), "Electron/43 Chrome/142.0.0.0");
  const contents = {
    setUserAgent(value) {
      this.userAgent = value;
    },
  };
  const browserSession = {
    setUserAgent(value, language) {
      this.userAgent = value;
      this.language = language;
    },
  };

  await manager.apply("tab-1", contents, browserSession, profile);
  assert.equal(contents.userAgent, profile.ua);
  assert.equal(browserSession.userAgent, profile.ua);
  assert.equal(cdp.commands[0].method, "Emulation.setUserAgentOverride");
  assert.deepEqual(cdp.commands[0].params.userAgentMetadata.brands, profile.brands);

  const headers = applyIdentityHeaders(
    {
      "user-agent": "stale",
      "sec-ch-ua-platform": '"StaleOS"',
      "sec-ch-ua-arch": '"stale"',
      "x-fixture": "kept",
    },
    profile,
  );
  assert.equal(headers["User-Agent"], profile.ua);
  assert.equal(headers["Sec-CH-UA-Platform"], '"FixtureOS"');
  assert.equal(headers["Sec-CH-UA-Arch"], '"x86"');
  assert.match(headers["Sec-CH-UA"], /"Chromium";v="142"/);
  assert.equal(headers["Sec-CH-UA-Full-Version-List"], undefined, "high-entropy hints must not be added");
  assert.equal(headers["x-fixture"], "kept");
});

test("custom identity rejects a mismatched UA and Client Hints Chromium major", () => {
  const manager = new BrowserIdentityManager(new FakeCdp());
  assert.throws(
    () =>
      manager.buildProfile(
        { ...customSettings(), customUserAgentFullVersion: "141.0.0.0" },
        "Electron/43 Chrome/142.0.0.0",
      ),
    (error) => error.code === "INVALID_BROWSER_REQUEST",
  );
});
