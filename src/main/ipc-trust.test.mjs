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

test("all desktop IPC registrations pass through the trusted wrappers", () => {
  const source = readFileSync(path.join(import.meta.dirname, "ipc.ts"), "utf8");
  assert.equal(source.match(/ipcMain\.handle\(/g)?.length, 1, "only trustedHandle may call ipcMain.handle");
  assert.equal(source.match(/ipcMain\.on\(/g)?.length, 1, "only trustedOn may call ipcMain.on");
  assert.equal(source.includes('"desktop:clear-badge"'), false, "the unused invoke badge channel must stay removed");
  assert.doesNotMatch(source, /assertTrustedToolchainSender/);
});
