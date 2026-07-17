import assert from "node:assert/strict";
import test from "node:test";

import { isProductionUpdatePlatformEnabled, wrapElectronUpdater } from "./update-adapter.ts";

class FakeElectronUpdater {
  constructor() {
    this.listeners = new Map();
    this.quitCalls = [];
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = true;
    this.allowDowngrade = true;
    this.disableWebInstaller = false;
    this.forceDevUpdateConfig = false;
    this.logger = { info() {} };
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  async checkForUpdates() {
    return "checked";
  }

  async downloadUpdate() {
    return ["downloaded"];
  }

  quitAndInstall(...args) {
    this.quitCalls.push(args);
  }
}

test("production adapter applies the stable, consent-first updater policy", async () => {
  const previous = process.env.PI_DESKTOP_TEST_UPDATER;
  delete process.env.PI_DESKTOP_TEST_UPDATER;
  try {
    const updater = new FakeElectronUpdater();
    const adapter = wrapElectronUpdater(updater);

    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
    assert.equal(updater.disableWebInstaller, true);
    assert.equal(updater.forceDevUpdateConfig, false);
    assert.equal(updater.logger, null);

    let checks = 0;
    const unsubscribe = adapter.on("checking-for-update", () => checks++);
    updater.emit("checking-for-update");
    unsubscribe();
    updater.emit("checking-for-update");
    assert.equal(checks, 1);

    assert.equal(await adapter.checkForUpdates(), "checked");
    assert.deepEqual(await adapter.downloadUpdate(), ["downloaded"]);
    adapter.quitAndInstall();
    assert.deepEqual(updater.quitCalls, [[false, true]]);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_TEST_UPDATER;
    else process.env.PI_DESKTOP_TEST_UPDATER = previous;
  }
});

test("development update config requires an explicit adapter option", () => {
  const productionUpdater = new FakeElectronUpdater();
  wrapElectronUpdater(productionUpdater);
  assert.equal(productionUpdater.forceDevUpdateConfig, false);

  const developmentUpdater = new FakeElectronUpdater();
  wrapElectronUpdater(developmentUpdater, { useDevelopmentConfig: true });
  assert.equal(developmentUpdater.forceDevUpdateConfig, true);
});

test("production platform policy enables macOS and unsigned Windows releases", () => {
  assert.equal(isProductionUpdatePlatformEnabled("darwin"), true);
  assert.equal(isProductionUpdatePlatformEnabled("win32"), true);
  assert.equal(isProductionUpdatePlatformEnabled("linux"), false);
});
