import assert from "node:assert/strict";
import test from "node:test";

import { BrowserDialogController } from "./browser-dialog-controller.ts";

function fixture(handoff = {}) {
  const listeners = new Set();
  const commands = [];
  const releases = [];
  const cdp = {
    keepAttached: () => {
      const release = () => releases.push("keep");
      releases.push("keep-attached");
      return release;
    },
    subscribe: (_tabId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enableDomain: async () => {
      releases.push("page-enabled");
      return async () => releases.push("page-disabled");
    },
    sendCommand: async (_tabId, method, params) => {
      commands.push({ method, params });
    },
  };
  const requests = [];
  const controller = new BrowserDialogController({
    cdp,
    getContext: () => ({ sessionId: "session-1", origin: "https://example.com", title: "Example" }),
    requestHandoff: async (input) => {
      requests.push(input);
      return handoff.resolution ?? { handoffId: "handoff-1", outcome: "completed", accept: true };
    },
    graceMs: 5,
  });
  return {
    controller,
    commands,
    requests,
    releases,
    open: (type, message, extra = {}) => {
      for (const listener of listeners) {
        listener({
          method: "Page.javascriptDialogOpening",
          params: { type, message, ...extra },
        });
      }
    },
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("alerts are accepted locally and confirm dialogs become a user handoff", async () => {
  const value = fixture();
  await value.controller.beginAction("tab-1");

  value.open("alert", "Saved");
  await tick();
  assert.deepEqual(
    value.commands.map((command) => command.params),
    [{ accept: true }],
  );
  assert.equal(value.requests.length, 0);

  value.open("confirm", "Proceed?");
  await tick();
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0].kind, "dialog");
  assert.equal(value.requests[0].dialog.type, "confirm");
  assert.deepEqual(value.commands.at(-1), { method: "Page.handleJavaScriptDialog", params: { accept: true } });

  value.controller.endAction("tab-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(value.releases.includes("page-disabled"), "Page domain must be released after the grace period");
});

test("cancelled confirm and prompt text are forwarded to Chromium", async () => {
  const value = fixture({
    resolution: { handoffId: "handoff-2", outcome: "completed", accept: true, promptText: "Ada" },
  });
  await value.controller.beginAction("tab-1");
  value.open("prompt", "Your name?", { defaultPrompt: "anonymous" });
  await tick();
  assert.deepEqual(value.commands.at(-1), {
    method: "Page.handleJavaScriptDialog",
    params: { accept: true, promptText: "Ada" },
  });

  const denied = fixture({ resolution: { handoffId: "handoff-3", outcome: "cancelled", accept: false } });
  await denied.controller.beginAction("tab-1");
  denied.open("confirm", "Delete?");
  await tick();
  assert.deepEqual(denied.commands.at(-1), {
    method: "Page.handleJavaScriptDialog",
    params: { accept: false },
  });
});

test("beforeunload is accepted so Agent navigation cannot stall", async () => {
  const value = fixture();
  await value.controller.beginAction("tab-1");
  value.open("beforeunload", "Leave?");
  await tick();
  assert.equal(value.requests.length, 0);
  assert.deepEqual(value.commands.at(-1), { method: "Page.handleJavaScriptDialog", params: { accept: true } });
});

test("detachAll releases the Page domain immediately on revoke", async () => {
  const value = fixture();
  await value.controller.beginAction("tab-1");
  value.controller.detachAll();
  assert.ok(value.releases.includes("page-disabled"));
  assert.ok(value.releases.includes("keep"));
});
