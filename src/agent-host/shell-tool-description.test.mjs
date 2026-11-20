import assert from "node:assert/strict";
import test from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { withShellToolDescriptionParameter } from "./shell-tool-description.ts";

for (const [name, createDefinition] of [
  ["Bash", (operations) => createBashToolDefinition("/workspace", { operations })],
  ["PowerShell", (operations) => createPowerShellToolDefinition("/workspace", { operations })],
]) {
  test(`${name} description parameter is optional in the real SDK schema`, () => {
    const definition = createDefinition({ exec: async () => ({ exitCode: 0 }) });
    const original = definition.parameters;
    const wrapped = withShellToolDescriptionParameter(definition);

    assert.deepEqual(wrapped.parameters.required, original.required);
    assert.deepEqual(wrapped.parameters.properties.command, original.properties.command);
    assert.deepEqual(wrapped.parameters.properties.timeout, original.properties.timeout);
    assert.equal(wrapped.parameters.properties.description.type, "string");
    assert.match(wrapped.parameters.properties.description.description, /user's language/u);
    assert.equal(wrapped.description, definition.description);
    assert.equal(wrapped.outputSchema, definition.outputSchema);
    assert.equal(wrapped.prepareArguments, definition.prepareArguments);
    assert.equal(wrapped.execute, definition.execute);
    assert.deepEqual(wrapped.parameters.required, ["command"], "description must not become required");

    const validate = Compile(wrapped.parameters);
    assert.equal(validate.Check({ command: "echo fixture" }), true);
    assert.equal(validate.Check({ command: "echo fixture", timeout: 5, description: "List files" }), true);
    assert.equal(validate.Check({ description: "List files" }), false, "the SDK-required command stays required");
  });

  test(`${name} optional description does not change command or timeout execution`, async () => {
    const calls = [];
    const operations = {
      async exec(command, cwd, options) {
        calls.push({ command, cwd, timeout: options.timeout });
        options.onData(Buffer.from("fixture output"));
        return { exitCode: 0 };
      },
    };
    const definition = withShellToolDescriptionParameter(createDefinition(operations));
    const params = { command: "printf fixture", timeout: 7, description: "Print fixture text" };

    const result = await definition.execute("call", params, undefined, undefined, undefined);

    assert.deepEqual(calls, [{ command: params.command, cwd: "/workspace", timeout: params.timeout }]);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /fixture output/u);
    assert.deepEqual(calls[0], { command: "printf fixture", cwd: "/workspace", timeout: 7 });

    calls.length = 0;
    await definition.execute(
      "call-without-description",
      { command: "printf fixture" },
      undefined,
      undefined,
      undefined,
    );
    assert.deepEqual(calls, [{ command: "printf fixture", cwd: "/workspace", timeout: undefined }]);
  });
}
