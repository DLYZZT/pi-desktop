import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import test from "node:test";

test("managed process owner identity is exact and one-time per Host generation", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "getCreationTime");
  Object.defineProperty(process, "getCreationTime", { value: () => 1_700_000_000_123, configurable: true });
  try {
    const module = await import(`./owner-identity.ts?generation=${randomUUID()}`);
    assert.throws(() => module.applyManagedProcessOwnerIdentity({}), /Invalid managed process owner identity/);
    const hostInstanceId = randomUUID();
    const value = module.applyManagedProcessOwnerIdentity({
      version: 1,
      mainPid: 456,
      mainStartFingerprint: "1700000000122",
      mainImagePath: realpathSync.native(process.execPath),
      hostInstanceId,
    });
    assert.equal(value.hostInstanceId, hostInstanceId);
    assert.equal(value.hostPid, process.pid);
    assert.equal(value.hostStartFingerprint, "1700000000123");
    assert.equal(value.hostImagePath, realpathSync.native(process.execPath));
    assert.throws(() => module.applyManagedProcessOwnerIdentity({}), /already initialized/);
    const copy = module.getManagedProcessOwnerIdentity();
    copy.hostPid = 999;
    assert.equal(module.getManagedProcessOwnerIdentity().hostPid, process.pid);
  } finally {
    if (original) Object.defineProperty(process, "getCreationTime", original);
    else delete process.getCreationTime;
  }
});

test("managed process owner identity fails closed when creation time is unavailable", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "getCreationTime");
  Object.defineProperty(process, "getCreationTime", { value: () => null, configurable: true });
  try {
    const module = await import(`./owner-identity.ts?generation=${randomUUID()}`);
    assert.throws(
      () =>
        module.applyManagedProcessOwnerIdentity({
          version: 1,
          mainPid: 456,
          mainStartFingerprint: "1700000000122",
          mainImagePath: realpathSync.native(process.execPath),
          hostInstanceId: randomUUID(),
        }),
      /creation time is unavailable/,
    );
  } finally {
    if (original) Object.defineProperty(process, "getCreationTime", original);
    else delete process.getCreationTime;
  }
});
