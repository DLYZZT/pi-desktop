import assert from "node:assert/strict";
import test from "node:test";
import { RpcError } from "../../contract/types.ts";
import { enUS, zhCN, zhTW } from "../i18n/session.ts";
import { sessionClientErrorMessage, unavailableSessionDirectoryMessage } from "./session-error-message.ts";

test("missing-directory notices and command errors use the same localized copy and preserve the saved path", () => {
  const cwd = "/work/$&/project";
  const error = new RpcError({ code: "SESSION_CWD_UNAVAILABLE", message: "Host error", detail: { cwd } });
  for (const [dictionary, expected] of [
    [enUS, "The session's working directory is unavailable (/work/$&/project). Restore it to resume this session."],
    [zhCN, "会话的原工作目录不可用（/work/$&/project）。恢复目录后即可继续此会话。"],
    [zhTW, "會話的原工作目錄無法存取（/work/$&/project）。還原目錄後即可繼續此會話。"],
  ]) {
    const t = (key, fallback) => dictionary[key] ?? fallback;
    assert.equal(unavailableSessionDirectoryMessage(cwd, t), expected);
    assert.equal(sessionClientErrorMessage(error, t, "Fallback"), expected);
  }
});

test("the damaged record's line and available recovery are localized in every Desktop language", () => {
  for (const dictionary of [enUS, zhCN, zhTW]) {
    const t = (key) => dictionary[key];
    assert.equal(
      sessionClientErrorMessage(
        new RpcError({ code: "SESSION_FORK_SOURCE_CHANGED", message: "raw SDK error" }),
        t,
        "fallback",
      ),
      dictionary.sessionDirectoryForkSourceChanged,
    );
    for (const [code, key] of [
      ["SESSION_FORK_INCOMPLETE_TAIL", "sessionDirectoryForkIncompleteTail"],
      ["SESSION_FORK_INVALID_HISTORY", "sessionDirectoryForkInvalidHistory"],
    ]) {
      const error = new RpcError({ code, message: "raw SDK error", detail: { line: 17 } });
      assert.equal(sessionClientErrorMessage(error, t, "fallback"), dictionary[key].replace("{line}", "17"));
      assert.ok(dictionary.sessionDirectoryForkRecoverTail);
    }
  }
});
