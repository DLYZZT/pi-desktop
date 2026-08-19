import assert from "node:assert/strict";
import test from "node:test";

import {
  dockRangeToCssRect,
  findDockRowRange,
  folderLabel,
  parseChromeModel,
  parseDockChrome,
  screenHasLiveStatus,
  thinkingCycleSteps,
} from "./tui-dock-rect.ts";

const rule = "─".repeat(40);

test("dock range wraps official editor rules plus footer, not the last assistant line", () => {
  const range = findDockRowRange([
    "Which module or package should I work on?",
    rule,
    "",
    rule,
    "~/workspaces/pi-mono (main)",
    "↑4.7k ↓44 R3.8k $0.009 (sub) 1.7%/272k (auto)                    (openai-codex) gpt-5.2-codex • medium",
  ]);
  assert.deepEqual(range, { start: 1, end: 5 });
});

test("dock range wraps user status, path, editor, and token footer", () => {
  const range = findDockRowRange([
    "assistant said something long about the plan",
    "PR #23: closed  MCP: 7 servers enabled (2 connected) SuperGrok 20% (8/22 23:45)",
    "F:\\Project\\dlyzzt-pi-desktop (feat/subagent-tool-card-status)",
    rule,
    "",
    rule,
    "↑139k ↓9.5k R822k CH96.8% $0.746 (sub) 14.5%/500k (auto)           (xai) grok-4.6 • high",
  ]);
  assert.deepEqual(range, { start: 1, end: 6 });
});

test("dock range without borders still takes the bottom chrome cluster plus the input row", () => {
  const range = findDockRowRange([
    "conversation text",
    "",
    "hello there",
    "F:\\Project\\dlyzzt-pi-desktop (feat/subagent-tool-card-status)",
    "↑139k ↓9.5k $0.746 (sub)",
  ]);
  assert.deepEqual(range, { start: 3, end: 4 });
});

test("live status is Working/Thinking/Compacting or a spinner, not an idle PTY footer", () => {
  assert.equal(screenHasLiveStatus(["assistant output", "\u2826 Working", "MCP: 2 connected"]), true);
  assert.equal(screenHasLiveStatus(["Thinking", "F:\\repo"]), true);
  assert.equal(screenHasLiveStatus(["Compacting context"]), true);
  assert.equal(
    screenHasLiveStatus(["F:\\Project\\dlyzzt-pi-desktop", "\u2191139k \u21939.5k $0.746 (sub)", "MCP: 2 connected"]),
    false,
  );
  assert.equal(screenHasLiveStatus([]), false);
});

test("dock range stays below the Working spinner", () => {
  const range = findDockRowRange([
    "assistant output",
    "\u2826 Working",
    "PR #23: closed  MCP: 7 servers enabled (2 connected)",
    "F:\\Project\\dlyzzt-pi-desktop (feat/subagent-tool-card-status)",
    rule,
    "",
    rule,
    "\u2191139k \u21939.5k $0.746 (sub)",
  ]);
  assert.deepEqual(range, { start: 2, end: 7 });
});

test("empty viewport has no dock", () => {
  assert.equal(findDockRowRange([]), null);
  assert.equal(findDockRowRange(["", "  ", ""]), null);
});

test("parseDockChrome reads this product's footer, path, and status line", () => {
  const chrome = parseDockChrome([
    "PR #23: closed \uD83D\uDD0C MCP: 7 servers enabled (2 connected) SuperGrok 20% (8/22 23:45)",
    "F:\\Project\\dlyzzt-pi-desktop (feat/subagent-tool-card-status)",
    "\u2191139k \u21939.5k R822k CH96.8% $0.746 (sub) 14.5%/500k (auto)           (xai) grok-4.6 \u2022 high",
  ]);
  assert.equal(chrome.path, "F:\\Project\\dlyzzt-pi-desktop (feat/subagent-tool-card-status)");
  assert.equal(chrome.usage, "\u2191139k \u21939.5k R822k CH96.8% $0.746 (sub) 14.5%/500k");
  assert.equal(chrome.model, "(xai) grok-4.6");
  assert.equal(chrome.thinking, "high");
  assert.deepEqual(chrome.statuses, [
    "PR #23: closed",
    "MCP: 7 servers enabled (2 connected)",
    "SuperGrok 20% (8/22 23:45)",
  ]);
});

test("chrome model parses provider and id", () => {
  assert.deepEqual(parseChromeModel("(xai) grok-4.6"), { provider: "xai", id: "grok-4.6" });
  assert.deepEqual(parseChromeModel("(openai-codex) gpt-5.2-codex"), {
    provider: "openai-codex",
    id: "gpt-5.2-codex",
  });
  assert.equal(parseChromeModel(null), null);
});

test("thinking cycle steps wrap forward from the current level", () => {
  const levels = ["off", "low", "medium", "high"];
  assert.equal(thinkingCycleSteps("medium", "high", levels), 1);
  assert.equal(thinkingCycleSteps("high", "off", levels), 1);
  assert.equal(thinkingCycleSteps("low", "low", levels), 0);
  assert.equal(thinkingCycleSteps("mystery", "high", levels), 0);
});

test("folder label uses the last path segment on Windows and POSIX", () => {
  assert.equal(folderLabel("F:\\Project\\dlyzzt-pi-desktop"), "dlyzzt-pi-desktop");
  assert.equal(folderLabel("/Users/doe/src/pi-mono"), "pi-mono");
  assert.equal(folderLabel("repo/"), "repo");
});

test("dock CSS rect maps rows onto the xterm screen box", () => {
  const rect = dockRangeToCssRect(
    { start: 10, end: 13 },
    { left: 20, top: 40, width: 800, height: 400 },
    { left: 10, top: 10 },
    80,
    20,
    6,
  );
  assert.deepEqual(rect, { left: 4, top: 224, width: 812, height: 92 });
});
