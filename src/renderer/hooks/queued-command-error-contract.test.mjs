import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const submissionSource = readFileSync(new URL("./useComposerSubmission.ts", import.meta.url), "utf8");

test("queued command handlers notify and reject on command failures", () => {
  for (const [logMessage, translationKey] of [
    ["Failed to steer:", "steerFailedNotQueued"],
    ["Failed to queue prompt:", "promptQueueFailedNotQueued"],
    ["Failed to follow up:", "followUpQueueFailedNotQueued"],
  ]) {
    const logIndex = hookSource.indexOf(`console.error("${logMessage}", error);`);
    assert.notEqual(logIndex, -1);
    const rejectionBlock = hookSource.slice(logIndex, hookSource.indexOf("throw error;", logIndex) + 12);
    assert.match(rejectionBlock, new RegExp(`t\\("${translationKey}"`));
    assert.match(rejectionBlock, /addNotice\(\{[\s\S]*?type: "error"/);
  }
});

test("queued command handlers reject a missing-session race", () => {
  assert.equal(
    (hookSource.match(/const error = new Error\("The active session is no longer available"\)/g) ?? []).length,
    3,
  );
  assert.equal((hookSource.match(/throw error;/g) ?? []).length >= 6, true);
});

test("composer submission blocks unrecoverable image queues, awaits text handlers, and restores rejected snapshots", () => {
  assert.match(submissionSource, /onSteer\?:[\s\S]*?Promise<void> \| void/);
  assert.match(submissionSource, /onFollowUp\?:[\s\S]*?Promise<void> \| void/);
  assert.match(submissionSource, /if \(attachedImages\.length > 0\)[\s\S]*?queuedImagesUnsupported[\s\S]*?return;/);
  assert.match(submissionSource, /await Promise\.resolve\(onSteer\(msg\)\)/);
  assert.match(submissionSource, /await Promise\.resolve\(onFollowUp\(msg\)\)/);
  assert.match(submissionSource, /catch \{\s*restoreFailedSubmission\(snapshot, clearedAtRevision, "queue"\)/);
});
