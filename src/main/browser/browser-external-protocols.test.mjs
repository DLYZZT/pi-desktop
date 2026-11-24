import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedExternalProtocolUrl } from "./browser-external-protocols.ts";

test("allows the reviewed external application protocols", () => {
  for (const url of [
    "mailto:user@example.com",
    "tel:+15555550100",
    "weixin://dl/business",
    "dingtalk://dingtalkclient/action/openapp",
    "msteams://teams.microsoft.com/l/chat",
    "slack://channel?team=T1&id=C1",
    "zoommtg://zoom.us/join?confno=1",
  ]) {
    assert.equal(isAllowedExternalProtocolUrl(url), true, url);
  }
});

test("blocks file, script, data, http and malformed protocols", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "custom-app://open",
    "https://example.com",
    "not a url",
    "mailto:user@example.com\nfile:///etc/passwd",
  ]) {
    assert.equal(isAllowedExternalProtocolUrl(url), false, url);
  }
});
