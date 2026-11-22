import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserDevice, browserDevicePresentation, applyBrowserDevice } from "./browser-device-mode.ts";

const desktop = { mode: "desktop" };

test("device preset rotates without mutating its canonical dimensions and supports custom DPR", () => {
  const phone = resolveBrowserDevice({ mode: "preset", presetId: "galaxy-a55" }, desktop);
  assert.deepEqual(phone, {
    mode: "mobile",
    presetId: "galaxy-a55",
    width: 360,
    height: 800,
    dpr: 3,
    orientation: "portrait",
    touch: true,
  });
  const rotated = resolveBrowserDevice({ mode: "rotate" }, phone);
  assert.deepEqual([rotated.width, rotated.height, rotated.orientation], [800, 360, "landscape"]);
  assert.deepEqual([phone.width, phone.height], [360, 800]);
  const custom = resolveBrowserDevice({ mode: "custom", width: 400, height: 900, dpr: 2.5, touch: false }, phone);
  assert.equal(custom.dpr, 2.5);
  assert.equal(custom.touch, false);
  assert.equal(custom.presetId, null);
  for (const input of [
    null,
    { mode: "rotate" },
    { mode: "preset", presetId: "toString" },
    { mode: "custom", width: 0, height: 800, dpr: 3 },
    { mode: "custom", width: 400, height: 800, dpr: Infinity },
  ]) {
    assert.throws(
      () => resolveBrowserDevice(input, desktop),
      (error) => error.code === "INVALID_BROWSER_REQUEST",
    );
  }
});

test("fitted native preview stays inside the surface without changing CSS device metrics", async () => {
  const phone = resolveBrowserDevice({ mode: "preset", presetId: "galaxy-a55" }, desktop);
  const fitted = browserDevicePresentation(phone, { x: 10, y: 20, width: 240, height: 500 });
  assert.equal(fitted.scale, 0.625);
  assert.deepEqual(fitted.bounds, { x: 17, y: 20, width: 225, height: 500 });
  const calls = [];
  const cdp = {
    keepAttached() {},
    async sendCommand(_tab, method, params) {
      calls.push({ method, params });
    },
  };
  await applyBrowserDevice(cdp, "tab", phone, fitted.scale);
  const metrics = calls.find(({ method }) => method === "Emulation.setDeviceMetricsOverride").params;
  assert.deepEqual([metrics.width, metrics.height, metrics.deviceScaleFactor, metrics.scale], [360, 800, 3, 0.625]);
  await applyBrowserDevice(cdp, "tab", desktop, 1);
  assert.equal(calls.at(-1).params.enabled, false);
  assert.ok(calls.some(({ method }) => method === "Emulation.clearDeviceMetricsOverride"));
});
