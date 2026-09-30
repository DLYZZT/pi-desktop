import assert from "node:assert/strict";
import test from "node:test";
import { customUiKey, customUiWheel, closeCustomUiOnAbort } from "./custom-ui-input.ts";
const key = (name, options = {}) =>
  customUiKey({ key: name, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...options });

for (const [name, options, expected] of [
  ["Escape", {}, "\x1b"],
  ["Enter", {}, "\r"],
  ["Enter", { shiftKey: true }, "\x1b[13;2u"],
  ["ArrowUp", {}, "\x1b[A"],
  ["ArrowDown", { ctrlKey: true }, "\x1b[1;5B"],
  ["Tab", { shiftKey: true }, "\x1b[Z"],
  ["Backspace", {}, "\x7f"],
  ["Backspace", { altKey: true }, "\x1b\x7f"],
  ["Home", {}, "\x1b[H"],
  ["End", {}, "\x1b[F"],
  ["PageUp", {}, "\x1b[5~"],
  ["Delete", {}, "\x1b[3~"],
  ["s", { ctrlKey: true }, "\x13"],
  ["c", { ctrlKey: true }, "\x03"],
  ["k", { ctrlKey: true }, "\x0b"],
])
  test(`keyboard ${name} ${JSON.stringify(options)}`, () => assert.equal(key(name, options), expected));

test("printable, composed, dead, AltGraph, and native Command keys are not keydown text", () => {
  for (const name of ["x", "á", "你", "🙂", "Dead", "Process"]) assert.equal(key(name), null);
  assert.equal(key("Enter", { isComposing: true }), null);
  assert.equal(key("v", { metaKey: true }), null);
  assert.equal(key("q", { ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph" }), null);
});

test("wheel input is an SGR wheel event recognized by Bro", () => {
  assert.equal(customUiWheel(-3), "\x1b[<64;1;1M");
  assert.equal(customUiWheel(3), "\x1b[<65;1;1M");
  assert.equal(customUiWheel(0), null);
  assert.equal(customUiWheel(NaN), null);
});

test("owner abort closes exactly once", () => {
  const controller = new globalThis.AbortController();
  let count = 0;
  closeCustomUiOnAbort(controller.signal, () => count++);
  controller.abort();
  controller.abort();
  assert.equal(count, 1);
});

test("retired owner listener does not close a later panel", () => {
  const controller = new globalThis.AbortController();
  let count = 0;
  const unbind = closeCustomUiOnAbort(controller.signal, () => count++);
  unbind();
  controller.abort();
  assert.equal(count, 0);
});

test("already aborted owner closes immediately", () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  let count = 0;
  closeCustomUiOnAbort(controller.signal, () => count++);
  assert.equal(count, 1);
});
