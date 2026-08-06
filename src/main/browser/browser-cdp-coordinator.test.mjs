import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";

class FakeDebugger extends EventEmitter {
  attached = false;
  commands = [];
  detachCount = 0;

  isAttached() {
    return this.attached;
  }

  attach(version) {
    assert.equal(version, "1.3");
    this.attached = true;
  }

  detach() {
    this.attached = false;
    this.detachCount += 1;
    this.emit("detach");
  }

  async sendCommand(method, params, sessionId) {
    this.commands.push({ method, params, sessionId });
    return { ok: true };
  }
}

function fakeContents() {
  return {
    debugger: new FakeDebugger(),
    isDestroyed: () => false,
  };
}

test("CDP coordinator reference-counts domains and does not detach concurrent users", async () => {
  const coordinator = new BrowserCdpCoordinator();
  const contents = fakeContents();
  coordinator.register("tab-1", contents);
  const releaseKeep = coordinator.keepAttached("tab-1", "identity");
  const releaseNetworkOne = await coordinator.enableDomain("tab-1", "Network", { maxTotalBufferSize: 100 });
  const releaseNetworkTwo = await coordinator.enableDomain("tab-1", "Network");
  const releaseTemporary = coordinator.acquire("tab-1");

  assert.equal(contents.debugger.commands.filter(({ method }) => method === "Network.enable").length, 1);
  releaseTemporary();
  await releaseNetworkOne();
  assert.equal(
    contents.debugger.commands.some(({ method }) => method === "Network.disable"),
    false,
  );
  await releaseNetworkTwo();
  assert.equal(contents.debugger.commands.filter(({ method }) => method === "Network.disable").length, 1);
  assert.equal(contents.debugger.isAttached(), true, "identity still owns the debugger");
  releaseKeep();
  assert.equal(contents.debugger.isAttached(), false);
  assert.equal(coordinator.countAttached(), 0);
});

test("CDP coordinator routes events and cleans listeners and attachment on tab disposal", () => {
  const coordinator = new BrowserCdpCoordinator();
  const contents = fakeContents();
  coordinator.register("tab-1", contents);
  const events = [];
  coordinator.subscribe("tab-1", (event) => events.push(event));
  coordinator.keepAttached("tab-1", "network");
  contents.debugger.emit("message", {}, "Network.loadingFinished", { requestId: "1" });
  assert.deepEqual(events, [{ method: "Network.loadingFinished", params: { requestId: "1" } }]);

  coordinator.disposeTab("tab-1");
  assert.equal(contents.debugger.isAttached(), false);
  assert.equal(contents.debugger.listenerCount("message"), 0);
  assert.equal(contents.debugger.listenerCount("detach"), 0);
});
