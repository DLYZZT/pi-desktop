import assert from "node:assert/strict";
import test from "node:test";

import { BrowserAgentRuntime } from "./browser-agent-runtime.ts";

const blocked = {
  code: "NAVIGATION_BLOCKED",
  retryable: false,
  recovery: { retryable: false, reason: "policy-denied", remediation: "ask-user" },
};
const transient = {
  code: "NAVIGATION_FAILED",
  retryable: true,
  recovery: {
    retryable: true,
    reason: "transient-network",
    remediation: "wait-and-retry-once",
    retryAfterMs: 1,
  },
};

test("attempt ledger blocks equivalent non-retryable navigation and allows only one transient retry", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");
  const first = runtime.beforeCall("session", "browser.open", { url: "http://example.com/path/", tabId: "one" }, 2);
  runtime.afterError("session", first.attemptKey, { url: "http://example.com/path/" }, blocked);
  assert.throws(
    () =>
      runtime.beforeCall("session", "browser.navigate", { url: "https://example.com/path", tabId: "different-tab" }, 2),
    (error) => error.code === "BROWSER_RETRY_BLOCKED",
  );

  runtime.beginTurn("transient", "local");
  const attemptOne = runtime.beforeCall(
    "transient",
    "browser.navigate",
    { url: "https://example.com/temporary", tabId: "tab" },
    2,
  );
  runtime.afterError("transient", attemptOne.attemptKey, { url: "https://example.com/temporary" }, transient);
  assert.equal(runtime.canAutoRetry(transient, "browser.navigate", attemptOne.attemptNumber), true);
  const attemptTwo = runtime.beforeCall(
    "transient",
    "browser.navigate",
    { url: "https://example.com/temporary", tabId: "tab" },
    2,
  );
  runtime.afterError("transient", attemptTwo.attemptKey, { url: "https://example.com/temporary" }, transient);
  assert.throws(
    () =>
      runtime.beforeCall("transient", "browser.navigate", { url: "https://example.com/temporary", tabId: "tab" }, 2),
    (error) => error.code === "BROWSER_RETRY_BLOCKED",
  );
});

test("Browser budgets issue one replan checkpoint and stop before call 61", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");
  for (let index = 0; index < 30; index += 1) {
    const attempt = runtime.beforeCall("session", "browser.listTabs", { marker: index }, 1);
    runtime.afterSuccess("session", attempt.attemptKey, { ok: true });
  }
  assert.throws(
    () => runtime.beforeCall("session", "browser.listTabs", { marker: "replan" }, 1),
    (error) => error.code === "BROWSER_REPLAN_REQUIRED",
  );
  for (let index = 30; index < 60; index += 1) {
    const attempt = runtime.beforeCall("session", "browser.listTabs", { marker: index }, 1);
    runtime.afterSuccess("session", attempt.attemptKey, { ok: true });
  }
  assert.throws(
    () => runtime.beforeCall("session", "browser.listTabs", { marker: 61 }, 1),
    (error) => error.code === "BROWSER_CALL_BUDGET_EXCEEDED",
  );
  runtime.beginTurn("session", "channel");
  assert.throws(
    () => runtime.beforeCall("session", "browser.listTabs", { marker: "channel-cannot-reset" }, 1),
    (error) => error.code === "BROWSER_CALL_BUDGET_EXCEEDED",
  );
  runtime.beginTurn("session", "local");
  const resumed = runtime.beforeCall("session", "browser.listTabs", {}, 1);
  runtime.afterSuccess("session", resumed.attemptKey, { ok: true });
  assert.equal(runtime.getMetrics("session").callCount, 1);
});

test("browser inspect is screenshot-free by default and requires deltas after two full observations", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");

  for (let index = 1; index <= 2; index += 1) {
    const params = index === 1 ? { tabId: "tab" } : {};
    const attempt = runtime.beforeCall("session", "browser.inspect", params, 1);
    runtime.afterSuccess(
      "session",
      attempt.attemptKey,
      { tabId: "tab", inspectionId: `inspection-${index}`, generation: 7 },
      "browser.inspect",
      params,
    );
  }

  assert.equal(runtime.getMetrics("session").screenshotCount, 0);
  assert.throws(
    () => runtime.beforeCall("session", "browser.inspect", { tabId: "tab" }, 1),
    (error) =>
      error.code === "BROWSER_REPLAN_REQUIRED" &&
      error.details.specializedTool === "browser_inspect" &&
      error.details.sinceInspectionId === "inspection-2" &&
      error.details.fullInspections === 2,
  );
  assert.equal(
    runtime.getMetrics("session").callCount,
    2,
    "a blocked full inspection must not consume the call budget",
  );

  const deltaParams = { tabId: "tab", sinceInspectionId: "inspection-2", screenshot: { enabled: true } };
  const delta = runtime.beforeCall("session", "browser.inspect", deltaParams, 1);
  runtime.afterSuccess(
    "session",
    delta.attemptKey,
    { tabId: "tab", inspectionId: "inspection-3", generation: 7, changed: false },
    "browser.inspect",
    deltaParams,
  );
  assert.equal(runtime.getMetrics("session").screenshotCount, 1, "only an explicitly enabled screenshot is charged");

  const navigationParams = { tabId: "tab", url: "https://example.com/next" };
  const navigation = runtime.beforeCall("session", "browser.navigate", navigationParams, 1);
  runtime.afterSuccess(
    "session",
    navigation.attemptKey,
    { tabId: "tab", generation: 8 },
    "browser.navigate",
    navigationParams,
  );
  const freshPage = runtime.beforeCall("session", "browser.inspect", { tabId: "tab" }, 1);
  runtime.afterSuccess(
    "session",
    freshPage.attemptKey,
    { tabId: "tab", inspectionId: "inspection-4", generation: 8 },
    "browser.inspect",
    { tabId: "tab" },
  );
});

test("JavaScript has independent explore and verify budgets with one explore replan checkpoint", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");
  const inspected = runtime.beforeCall(
    "session",
    "browser.inspect",
    { tabId: "tab", screenshot: { enabled: false } },
    1,
  );
  runtime.afterSuccess(
    "session",
    inspected.attemptKey,
    { tabId: "tab", inspectionId: "inspection", generation: 1 },
    "browser.inspect",
    { tabId: "tab" },
  );

  for (let index = 0; index < 3; index += 1) {
    const params = { tabId: "tab", source: `${index} + 1`, intent: "explore" };
    const attempt = runtime.beforeCall("session", "browser.executeJavaScript", params, 1);
    runtime.afterSuccess("session", attempt.attemptKey, { value: index + 1 }, "browser.executeJavaScript", params);
  }
  assert.throws(
    () =>
      runtime.beforeCall("session", "browser.executeJavaScript", { tabId: "tab", source: "4", intent: "explore" }, 1),
    (error) =>
      error.code === "BROWSER_REPLAN_REQUIRED" &&
      error.message.includes("budgetKind=javascript-explore; used=3; limit=4") &&
      error.details.budgetKind === "javascript-explore" &&
      error.details.used === 3 &&
      error.details.limit === 4,
  );
  const finalExploreParams = { tabId: "tab", source: "4", intent: "explore" };
  const finalExplore = runtime.beforeCall("session", "browser.executeJavaScript", finalExploreParams, 1);
  runtime.afterSuccess(
    "session",
    finalExplore.attemptKey,
    { value: 4 },
    "browser.executeJavaScript",
    finalExploreParams,
  );
  assert.throws(
    () =>
      runtime.beforeCall("session", "browser.executeJavaScript", { tabId: "tab", source: "5", intent: "explore" }, 1),
    (error) => error.code === "BROWSER_CALL_BUDGET_EXCEEDED" && error.details.used === 4,
  );

  for (let index = 0; index < 2; index += 1) {
    const params = {
      tabId: "tab",
      source: `document.title === ${JSON.stringify(String(index))}`,
      intent: "verify",
      expected: `title equals ${index}`,
    };
    const attempt = runtime.beforeCall("session", "browser.executeJavaScript", params, 1);
    runtime.afterSuccess("session", attempt.attemptKey, { value: false }, "browser.executeJavaScript", params);
  }
  assert.throws(
    () =>
      runtime.beforeCall(
        "session",
        "browser.executeJavaScript",
        { tabId: "tab", source: "true", intent: "verify", expected: "page is ready" },
        1,
      ),
    (error) => error.code === "BROWSER_CALL_BUDGET_EXCEEDED" && error.details.budgetKind === "javascript-verify",
  );
  assert.deepEqual(
    {
      total: runtime.getMetrics("session").javascriptCount,
      explore: runtime.getMetrics("session").javascriptExploreCount,
      verify: runtime.getMetrics("session").javascriptVerifyCount,
    },
    { total: 6, explore: 4, verify: 2 },
  );
});

test("specialized Browser tools must precede JavaScript and detailed network access", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");
  assert.throws(
    () =>
      runtime.beforeCall(
        "session",
        "browser.executeJavaScript",
        { tabId: "tab", source: "document.title", intent: "explore" },
        1,
      ),
    (error) => error.code === "BROWSER_REPLAN_REQUIRED" && error.details.specializedTool === "browser_inspect",
  );
  const inspected = runtime.beforeCall(
    "session",
    "browser.inspect",
    { tabId: "tab", screenshot: { enabled: false } },
    1,
  );
  runtime.afterSuccess(
    "session",
    inspected.attemptKey,
    { tabId: "tab", inspectionId: "inspection", generation: 1 },
    "browser.inspect",
    { tabId: "tab" },
  );
  assert.throws(
    () =>
      runtime.beforeCall(
        "session",
        "browser.executeJavaScript",
        { tabId: "tab", source: "fetch('/api')", intent: "explore" },
        1,
      ),
    (error) => error.code === "BROWSER_REPLAN_REQUIRED" && error.details.specializedTool === "browser_network_summary",
  );
  assert.throws(
    () => runtime.beforeCall("session", "browser.networkList", { tabId: "tab" }, 1),
    (error) => error.details.specializedTool === "browser_network_summary",
  );
  const summaryParams = { tabId: "tab" };
  const summary = runtime.beforeCall("session", "browser.networkSummary", summaryParams, 1);
  runtime.afterSuccess("session", summary.attemptKey, { total: 1 }, "browser.networkSummary", summaryParams);
  const list = runtime.beforeCall("session", "browser.networkList", { tabId: "tab" }, 1);
  runtime.afterSuccess("session", list.attemptKey, { requests: [] }, "browser.networkList", { tabId: "tab" });
  const networkJsParams = { tabId: "tab", source: "fetch('/api')", intent: "explore" };
  const networkJs = runtime.beforeCall("session", "browser.executeJavaScript", networkJsParams, 1);
  runtime.afterSuccess("session", networkJs.attemptKey, { value: true }, "browser.executeJavaScript", networkJsParams);
  assert.throws(
    () =>
      runtime.beforeCall(
        "session",
        "browser.executeJavaScript",
        { tabId: "tab", source: "window.onerror = () => true", intent: "explore" },
        1,
      ),
    (error) => error.details.specializedTool === "browser_console_list",
  );
  const consoleParams = { tabId: "tab" };
  const consoleList = runtime.beforeCall("session", "browser.consoleList", consoleParams, 1);
  runtime.afterSuccess("session", consoleList.attemptKey, { entries: [] }, "browser.consoleList", consoleParams);
  const hookParams = { tabId: "tab", source: "window.onerror = () => true", intent: "explore" };
  const hook = runtime.beforeCall("session", "browser.executeJavaScript", hookParams, 1);
  runtime.afterSuccess("session", hook.attemptKey, { value: true }, "browser.executeJavaScript", hookParams);
});

test("JavaScript execution failures stay in the attempt ledger while corrected source can continue", () => {
  const runtime = new BrowserAgentRuntime();
  runtime.beginTurn("session", "local");
  const inspected = runtime.beforeCall(
    "session",
    "browser.inspect",
    { tabId: "tab", screenshot: { enabled: false } },
    1,
  );
  runtime.afterSuccess(
    "session",
    inspected.attemptKey,
    { tabId: "tab", inspectionId: "inspection", generation: 1 },
    "browser.inspect",
    { tabId: "tab" },
  );
  const invalid = { tabId: "tab", source: "return true", intent: "explore" };
  const failed = runtime.beforeCall("session", "browser.executeJavaScript", invalid, 1);
  runtime.afterError("session", failed.attemptKey, invalid, {
    code: "JAVASCRIPT_EXECUTION_FAILED",
    retryable: false,
    recovery: { retryable: false, reason: "invalid-input", remediation: "change-input" },
  });
  assert.throws(
    () => runtime.beforeCall("session", "browser.executeJavaScript", invalid, 1),
    (error) => error.code === "BROWSER_RETRY_BLOCKED",
  );
  const corrected = { tabId: "tab", source: "true", intent: "explore" };
  const accepted = runtime.beforeCall("session", "browser.executeJavaScript", corrected, 1);
  runtime.afterSuccess("session", accepted.attemptKey, { value: true }, "browser.executeJavaScript", corrected);
  assert.equal(runtime.getMetrics("session").javascriptExploreCount, 2);
});

test("workflow guard asks locally for same-target curl and Playwright routes but ignores unrelated coding", async () => {
  const requests = [];
  const runtime = new BrowserAgentRuntime(async (request) => {
    requests.push(request);
    return { allowed: false };
  });
  runtime.beginTurn("session", "local");
  const attempt = runtime.beforeCall(
    "session",
    "browser.open",
    { url: "https://internal.example/private?token=secret" },
    1,
  );
  runtime.afterError("session", attempt.attemptKey, { url: "https://internal.example/private?token=secret" }, blocked);
  await runtime.guardBash("session", "npm test");
  await assert.rejects(
    runtime.guardBash("session", "curl https://internal.example/private?token=secret"),
    (error) => error.code === "BROWSER_ROUTE_BYPASS_BLOCKED",
  );
  await assert.rejects(
    runtime.guardBash("session", "npx playwright install chromium"),
    (error) => error.code === "BROWSER_ROUTE_BYPASS_BLOCKED",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    Object.keys(requests[0]).sort(),
    ["origin", "requestId", "ruleId", "sessionId"],
    "full shell and URL query are never sent to Main",
  );
  assert.equal(requests[0].origin, "https://internal.example");
});
