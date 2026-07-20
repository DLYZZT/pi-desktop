import assert from "node:assert/strict";
import test from "node:test";
import { isToolchainActionRequest } from "./types.ts";

test("accepts only fixed toolchain actions with exact safe fields", () => {
  for (const action of [
    { action: "install-profile", profileId: "python-essentials" },
    { action: "install-component", componentId: "node-lts" },
    { action: "repair-component", componentId: "uv" },
    { action: "cancel-component-install", componentId: "uv" },
    { action: "remove-component", componentId: "cpython" },
    { action: "set-preference", capability: "js.node", preference: "managed" },
    { action: "choose-custom-tool", capability: "python.interpreter" },
    { action: "clear-cache", cacheId: "npm" },
    { action: "rescan" },
  ]) {
    assert.equal(isToolchainActionRequest(action), true);
  }
  for (const unsafe of [
    { action: "install-component", componentId: "node-lts", url: "https://evil.invalid" },
    { action: "install-component", componentId: "../../node-lts" },
    { action: "cancel-component-install", componentId: "../../node-lts" },
    { action: "set-preference", capability: "js.node", preference: "path", executable: "/tmp/node" },
    { action: "choose-custom-tool", capability: "js.node", executable: "/tmp/node" },
    { action: "clear-cache", cacheId: "../../home" },
    { action: "run", command: "curl" },
  ]) {
    assert.equal(isToolchainActionRequest(unsafe), false);
  }
});
