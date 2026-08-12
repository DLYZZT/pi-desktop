import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const inputSource = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

test("queued command handlers notify and reject on command failures", () => {
  for (const [logMessage, noticeMessage] of [
    ["Failed to steer:", "Unable to steer the running agent. The message was not queued."],
    ["Failed to queue prompt:", "Unable to queue this prompt. The message was not queued."],
    ["Failed to follow up:", "Unable to queue this follow-up. The message was not queued."],
  ]) {
    assert.ok(
      hookSource.includes(
        `console.error("${logMessage}", error);\n        addNotice({ type: "error", message: "${noticeMessage}" });\n        throw error;`,
      ),
    );
  }
});

test("queued command handlers reject a missing-session race", () => {
  assert.equal(
    (hookSource.match(/const error = new Error\("The active session is no longer available"\)/g) ?? []).length,
    3,
  );
  assert.equal((hookSource.match(/throw error;/g) ?? []).length >= 6, true);
});

test("ChatInput awaits queue handlers and restores revision-aware snapshots after rejection", () => {
  assert.match(inputSource, /onSteer\?:[\s\S]*?Promise<void> \| void/);
  assert.match(inputSource, /onFollowUp\?:[\s\S]*?Promise<void> \| void/);
  assert.match(inputSource, /await Promise\.resolve\(onSteer\(msg, undefined\)\)/);
  assert.match(inputSource, /await Promise\.resolve\(onFollowUp\(msg, undefined\)\)/);
  assert.match(inputSource, /catch \{\s*restoreFailedSubmission\(snapshot, clearedAtRevision, "queue"\)/);
});
