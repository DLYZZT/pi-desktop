import assert from "node:assert/strict";
import test from "node:test";

import { runPackagedCleanupFaultValidation } from "./packaged-cleanup-fault-validation.ts";

test("packaged cleanup fault validation retains uncertainty and prevents installer launch", async () => {
  const report = await runPackagedCleanupFaultValidation({ productionDeadlineMs: 15_000, faultDeadlineMs: 20 });
  assert.equal(report.ok, true);
  assert.equal(report.journalRetained, true);
  assert.equal(report.installRejected, true);
  assert.equal(report.installerLaunches, 0);
  assert.equal(report.recoveries, 1);
  assert.equal(report.updatePhase, "error");
  assert.equal(report.canRetry, true);
});
