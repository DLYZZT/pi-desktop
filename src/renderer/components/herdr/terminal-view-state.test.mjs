import assert from "node:assert/strict";
import test from "node:test";
import { getTerminalViewState, terminalCloseOwnershipState, terminalFrameDisposition } from "./terminal-view-state.ts";

const status = (overrides = {}) => ({
  terminalId: "terminal-a",
  paneId: "pane-a",
  state: "controlling",
  mode: "control",
  controller: true,
  ansiOnly: true,
  ...overrides,
});

test("terminal frame sequencing accepts full recovery frames and rejects gaps", () => {
  assert.equal(terminalFrameDisposition(null, 7, true), "accept");
  assert.equal(terminalFrameDisposition(7, 8, false), "accept");
  assert.equal(terminalFrameDisposition(8, 8, false), "duplicate");
  assert.equal(terminalFrameDisposition(8, 10, false), "gap");
  assert.equal(terminalFrameDisposition(null, 1, false), "gap");
  assert.equal(terminalFrameDisposition(10, 15, true), "accept");
});

test("terminal ownership states distinguish another controller and a lost controller", () => {
  assert.equal(
    getTerminalViewState({ opening: false, ownershipState: null, status: status({ controller: false }) }),
    "controlled-elsewhere",
  );
  assert.equal(terminalCloseOwnershipState("control", "error"), "controller-lost");
  assert.equal(terminalCloseOwnershipState("control", "closed"), "controller-lost");
  assert.equal(terminalCloseOwnershipState("observe", "closed"), null);
  assert.equal(getTerminalViewState({ opening: true, ownershipState: "controller-lost", status: status() }), "opening");
});
