import assert from "node:assert/strict";
import test from "node:test";

import { getQuickChannelBindingPopoverLayout } from "./quick-channel-binding-layout.ts";

test("right-aligns the desktop popover without crossing the viewport gutter", () => {
  assert.deepEqual(
    getQuickChannelBindingPopoverLayout({
      trigger: { left: 1320, top: 8, right: 1410, bottom: 36 },
      viewportWidth: 1514,
      viewportHeight: 768,
      isMobile: false,
    }),
    { left: 1040, top: 44, width: 370, maxHeight: 440, placement: "bottom" },
  );
});

test("shrinks and clamps the desktop popover in a narrow window", () => {
  assert.deepEqual(
    getQuickChannelBindingPopoverLayout({
      trigger: { left: 70, top: 8, right: 150, bottom: 36 },
      viewportWidth: 320,
      viewportHeight: 600,
      isMobile: false,
    }),
    { left: 12, top: 44, width: 296, maxHeight: 440, placement: "bottom" },
  );
});

test("centers the mobile popover within the viewport", () => {
  assert.deepEqual(
    getQuickChannelBindingPopoverLayout({
      trigger: { left: 78, top: 8, right: 220, bottom: 36 },
      viewportWidth: 390,
      viewportHeight: 844,
      isMobile: true,
    }),
    { left: 25, top: 44, width: 340, maxHeight: 440, placement: "bottom" },
  );
});

test("places the popover above the trigger when a short viewport lacks room below", () => {
  assert.deepEqual(
    getQuickChannelBindingPopoverLayout({
      trigger: { left: 500, top: 300, right: 620, bottom: 336 },
      viewportWidth: 900,
      viewportHeight: 420,
      isMobile: false,
    }),
    { left: 250, top: 12, width: 370, maxHeight: 280, placement: "top" },
  );
});
