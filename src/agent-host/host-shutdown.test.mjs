import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { createHostShutdown } from "./host-shutdown.ts";

test("shutdown detaches synchronously, preserves async order and shares one completion", async () => {
  const calls = [],
    pending = createDeferred();
  const stop = createHostShutdown([
    {
      name: "listeners",
      stop: () => {
        calls.push("listeners");
      },
    },
    {
      name: "Herdr",
      stop: () => {
        calls.push("Herdr");
        return pending.promise;
      },
    },
    {
      name: "processes",
      stop: () => {
        calls.push("processes");
      },
    },
  ]);
  const first = stop(),
    second = stop();
  assert.equal(first, second);
  assert.deepEqual(calls, ["listeners", "Herdr"]);
  pending.resolve();
  await first;
  assert.deepEqual(calls, ["listeners", "Herdr", "processes"]);
  assert.equal(stop(), first);
});

test("failed steps retain their error and do not skip later resource cleanup", async () => {
  const calls = [],
    firstError = new Error("private first detail"),
    secondError = new Error("private second detail");
  const stop = createHostShutdown([
    {
      name: "Herdr",
      stop: () => {
        calls.push("Herdr");
        throw firstError;
      },
    },
    {
      name: "processes",
      stop: async () => {
        calls.push("processes");
        throw secondError;
      },
    },
    {
      name: "files",
      stop: () => {
        calls.push("files");
      },
    },
    {
      name: "sessions",
      stop: () => {
        calls.push("sessions");
      },
    },
  ]);
  await assert.rejects(
    stop(),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === firstError &&
      error.errors[1] === secondError &&
      error.message === "Host cleanup failed: Herdr, processes",
  );
  assert.deepEqual(calls, ["Herdr", "processes", "files", "sessions"]);
});
