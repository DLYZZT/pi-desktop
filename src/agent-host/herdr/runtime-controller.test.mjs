import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

test("runtime descriptors advance strictly and duplicate revisions never overwrite state", async () => {
  const { HerdrRuntimeController } = await importTestBundle("src/agent-host/herdr/runtime-controller", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/runtime-controller.ts"],
  });
  const controller = new HerdrRuntimeController();
  const revisions = [];
  controller.subscribe((descriptor) => revisions.push(descriptor.revision));
  const first = {
    revision: 1,
    enabled: false,
    mode: "attach",
    sessionName: "first",
    autoConnect: false,
    releaseControlOnViewClose: true,
  };
  controller.apply(first);
  controller.apply({ ...first, sessionName: "same-revision-must-not-win" });

  assert.equal(controller.get().sessionName, "first");
  assert.deepEqual(revisions, [1]);
  assert.throws(
    () => controller.apply({ ...first, revision: 0 }),
    (error) => error.code === "HERDR_REQUEST_CANCELLED",
  );

  assert.doesNotThrow(() => controller.apply({ ...first, revision: 2, hostGeneration: 7 }));
  assert.throws(
    () => controller.apply({ ...first, revision: 3, hostGeneration: 6 }),
    (error) => error.code === "HERDR_REQUEST_CANCELLED",
  );
});

test("an enabled probing descriptor is ACKable before executable discovery completes", async () => {
  const { HerdrRuntimeController } = await importTestBundle("src/agent-host/herdr/runtime-controller-probing", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/runtime-controller.ts"],
  });
  const controller = new HerdrRuntimeController();
  const probing = {
    revision: 1,
    enabled: true,
    probing: true,
    mode: "attach",
    sessionName: "desktop",
    autoConnect: true,
    releaseControlOnViewClose: true,
  };
  assert.doesNotThrow(() => controller.apply(probing));
  assert.equal(controller.get().probing, true);
  assert.throws(
    () => controller.apply({ ...probing, revision: 2, probing: false }),
    /enabled Herdr runtime descriptor is incomplete/,
  );
});
