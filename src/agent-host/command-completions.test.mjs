import assert from "node:assert/strict";
import test from "node:test";
import { commandArgumentCompletions } from "./command-completions.ts";
test("extension arguments are fetched with the actual prefix and do not submit complete commands", async () => {
  const commands = [
    {
      invocationName: "bro",
      getArgumentCompletions: (prefix) =>
        ["config", "btw"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    },
  ];
  assert.deepEqual(
    (await commandArgumentCompletions("/bro ", commands)).map((c) => c.name),
    ["bro config", "bro btw"],
  );
  assert.deepEqual(
    (await commandArgumentCompletions("/bro co", commands)).map((c) => c.name),
    ["bro config"],
  );
  assert.deepEqual(await commandArgumentCompletions("/bro config", commands), []);
  assert.deepEqual(await commandArgumentCompletions("/unknown ", commands), []);
  assert.deepEqual(
    await commandArgumentCompletions("/bad ", [
      {
        invocationName: "bad",
        getArgumentCompletions: () => {
          throw Error("extension failed");
        },
      },
    ]),
    [],
  );
});
test("a newer prefix waits for a slow provider without overlapping calls", async () => {
  let release;
  const calls = [];
  const commands = [
    {
      invocationName: "bro",
      getArgumentCompletions: async (prefix) => {
        calls.push(prefix);
        if (prefix === "c")
          await new Promise((resolve) => {
            release = resolve;
          });
        return [{ value: "config", label: "Configuration" }];
      },
    },
  ];
  const first = commandArgumentCompletions("/bro c", commands);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = commandArgumentCompletions("/bro co", commands);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["c"]);
  release();
  await first;
  assert.equal((await next)[0].name, "bro config");
  assert.deepEqual(calls, ["c", "co"]);
});
