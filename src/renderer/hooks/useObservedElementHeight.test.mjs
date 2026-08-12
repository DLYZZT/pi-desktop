import assert from "node:assert/strict";
import test from "node:test";

import { observeElementHeight, observedElementHeight } from "./useObservedElementHeight.ts";

test("observed heights are rounded, non-negative, and published immediately", () => {
  const heights = [];
  const element = { clientHeight: 420.4 };
  const dispose = observeElementHeight(element, (height) => heights.push(height), undefined);

  assert.equal(observedElementHeight({ clientHeight: -3 }), 0);
  assert.deepEqual(heights, [420]);
  dispose();
});

test("ResizeObserver updates height and disconnects during cleanup", () => {
  const heights = [];
  const element = { clientHeight: 300 };
  let callback;
  let observed;
  let disconnected = 0;
  class FakeResizeObserver {
    constructor(next) {
      callback = next;
    }
    observe(target) {
      observed = target;
    }
    disconnect() {
      disconnected += 1;
    }
  }

  const dispose = observeElementHeight(element, (height) => heights.push(height), FakeResizeObserver);
  element.clientHeight = 512;
  callback([], {});

  assert.equal(observed, element);
  assert.deepEqual(heights, [300, 512]);
  dispose();
  assert.equal(disconnected, 1);
});
