import assert from "node:assert/strict";
import test from "node:test";

import { setAppLanguage } from "../../i18n.ts";
import { browserErrorMessage } from "./browser-error-message.ts";

test("Browser errors are localized by stable code without exposing Main messages", () => {
  setAppLanguage("zh-CN");
  assert.equal(
    browserErrorMessage(new Error("USER_DENIED: internal Main detail must stay hidden")),
    "浏览器访问已被拒绝。",
  );
  assert.equal(browserErrorMessage(new Error("unknown internal failure")), "无法完成浏览器操作。");
  setAppLanguage("en-US");
  assert.equal(
    browserErrorMessage(new Error("AUTHORIZATION_TIMEOUT: private implementation detail")),
    "Browser authorization timed out.",
  );
});
