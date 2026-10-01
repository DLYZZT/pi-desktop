import assert from "node:assert/strict";
import test from "node:test";
import { enUS, zhCN } from "../i18n-dictionaries.ts";
import { localizedExtensionConfirmCopy } from "./extension-ui-copy.ts";

const translate = (dictionary) => (key, fallback) => dictionary[key] ?? fallback;
const base = { type: "extension_ui_request", id: "confirm-a", method: "confirm" };

test("Herdr extension confirmations localize semantic content without parsing fallback English", () => {
  assert.deepEqual(
    localizedExtensionConfirmCopy(
      {
        ...base,
        title: "fallback title",
        message: "fallback message",
        localization: { id: "herdr.closeWorkspace", target: "审查", paneCount: 2 },
      },
      translate(zhCN),
    ),
    {
      title: "关闭 Herdr 工作区",
      message: "关闭工作区“审查”？这将终止其中 2 个 pane 及其全部进程。Pi Desktop 无法撤销此操作。",
    },
  );
  assert.deepEqual(
    localizedExtensionConfirmCopy(
      {
        ...base,
        title: "fallback title",
        message: "fallback message",
        localization: { id: "herdr.closeAgentPane", paneId: "w1:p1", agentKind: "grok" },
      },
      translate(enUS),
    ),
    {
      title: "Close Herdr Agent pane",
      message:
        "Close the grok Agent by closing pane w1:p1? Herdr v0.8.2 cannot stop only the Agent; the pane and every process in it will terminate.",
    },
  );
});

test("generic extension confirmations preserve extension-provided copy", () => {
  assert.deepEqual(
    localizedExtensionConfirmCopy({ ...base, title: "Custom title", message: "Custom message" }, translate(zhCN)),
    { title: "Custom title", message: "Custom message" },
  );
});

test("MCP permission confirmation uses the existing modal with localized server scope and allow label", () => {
  const copy = localizedExtensionConfirmCopy(
    {
      ...base,
      title: "fallback",
      message: "fallback",
      localization: { id: "mcp.authorize", servers: "context7", tools: "resolve-library-id\nquery-docs", toolCount: 2 },
    },
    translate(zhCN),
  );
  assert.equal(copy.title, "允许使用 context7？");
  assert.equal(copy.confirmLabel, "允许当前会话使用");
  assert.equal(copy.subtitle, "MCP 工具授权");
  assert.match(copy.message, /2 个工具/);
  assert.match(copy.message, /本会话不再重复询问/);
  assert.match(copy.message, /query-docs/);
});
