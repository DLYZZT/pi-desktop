import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isTrustedDesktopIpcSender } from "./ipc-trust.ts";

test("desktop IPC trusts only the live main window main frame", () => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };

  assert.equal(isTrustedDesktopIpcSender(window, { sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(isTrustedDesktopIpcSender(window, { sender: {}, senderFrame: mainFrame }), false);
  assert.equal(isTrustedDesktopIpcSender(window, { sender: webContents, senderFrame: {} }), false);
  assert.equal(
    isTrustedDesktopIpcSender({ ...window, isDestroyed: () => true }, { sender: webContents, senderFrame: mainFrame }),
    false,
  );
  assert.equal(isTrustedDesktopIpcSender(null, { sender: webContents, senderFrame: mainFrame }), false);
});

test("desktop IPC can trust either cockpit window", () => {
  const leftFrame = {};
  const rightFrame = {};
  const left = { isDestroyed: () => false, webContents: { mainFrame: leftFrame } };
  const right = { isDestroyed: () => false, webContents: { mainFrame: rightFrame } };
  assert.equal(isTrustedDesktopIpcSender([left, right], { sender: left.webContents, senderFrame: leftFrame }), true);
  assert.equal(isTrustedDesktopIpcSender([left, right], { sender: right.webContents, senderFrame: rightFrame }), true);
  assert.equal(isTrustedDesktopIpcSender([left, right], { sender: {}, senderFrame: leftFrame }), false);
});

test("all desktop IPC registrations pass through the trusted wrappers", () => {
  const source = readFileSync(path.join(import.meta.dirname, "ipc.ts"), "utf8");
  assert.equal(source.match(/ipcMain\.handle\(/g)?.length, 1, "only trustedHandle may call ipcMain.handle");
  assert.equal(source.match(/ipcMain\.on\(/g)?.length, 1, "only trustedOn may call ipcMain.on");
  assert.equal(source.includes('"desktop:clear-badge"'), false, "the unused invoke badge channel must stay removed");
  assert.match(source, /trustedOn\("desktop:abort-session"/);
  assert.match(source, /trustedOn\("desktop:start-session-tui"/);
  assert.match(source, /trustedOn\("desktop:kill-session-tui"/);
  assert.match(source, /trustedHandle\("desktop:get-session-tui-marks"/);
  assert.doesNotMatch(source, /trustedHandle\("desktop:abort-session"/);
  assert.doesNotMatch(source, /trustedHandle\("desktop:start-session-tui"/);
  assert.doesNotMatch(source, /trustedHandle\("desktop:kill-session-tui"/);
  assert.doesNotMatch(source, /manager\.call\([^\n]*abort/i);
  assert.doesNotMatch(source, /assertTrustedToolchainSender/);
});
