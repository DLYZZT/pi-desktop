import assert from "node:assert/strict";
import test from "node:test";
import { enUS, zhCN } from "../i18n-dictionaries.ts";
import { sessionClientErrorMessage } from "../lib/session-error-message.ts";

const translate = (dictionary) => (key, fallback) => dictionary[key] ?? fallback;

test("localizes stable event stream connection errors", () => {
  const eventError = (status) =>
    Object.assign(new Error(`EVENT_STREAM_${status.toUpperCase()}`), {
      name: "EventStreamConnectionError",
      status,
    });
  assert.equal(
    sessionClientErrorMessage(eventError("timeout"), translate(enUS), "fallback"),
    "Timed out connecting to the agent event stream. Please try again.",
  );
  assert.equal(
    sessionClientErrorMessage(eventError("closed"), translate(zhCN), "回退"),
    "连接 Agent 事件流失败，请重试。",
  );
});

test("registers critical session notification flows in both languages", () => {
  const expected = {
    steerFailedNotQueued: [
      "Unable to steer the running agent. The message was not queued.",
      "无法引导正在运行的 Agent，该消息未加入队列。",
    ],
    promptQueueFailedNotQueued: [
      "Unable to queue this prompt. The message was not queued.",
      "无法排队此提示，该消息未加入队列。",
    ],
    followUpQueueFailedNotQueued: [
      "Unable to queue this follow-up. The message was not queued.",
      "无法排队此后续消息，该消息未加入队列。",
    ],
    modelDirectoryLoadFailed: [
      "Unable to load the model directory. Retry from the model picker or check the Agent Host connection.",
      "无法加载模型目录。请从模型选择器重试，或检查 Agent Host 连接。",
    ],
    sessionRenamedTo: ["Session renamed to {name}", "会话已重命名为 {name}"],
  };
  for (const [key, [english, chinese]] of Object.entries(expected)) {
    assert.equal(enUS[key], english);
    assert.equal(zhCN[key], chinese);
  }
});
