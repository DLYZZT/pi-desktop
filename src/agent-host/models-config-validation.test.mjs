import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { inspectModelsConfig, parseModelsConfig, preflightModelsConfig } from "./models-config-validation.ts";

test("target schema preflight lists every invalid field without changing config or creating runtime files", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-120-config-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "models.json");
  const config = {
    providers: {
      broken: {
        api: "openai-completions",
        baseUrl: "http://fixture.invalid",
        apiKey: "PRIVATE_FIXTURE_KEY",
        models: [{ id: "bad", contextWindow: 0, maxTokens: -1 }],
      },
      valid: {
        api: "openai-completions",
        baseUrl: "http://fixture.invalid",
        models: [{ id: "good", contextWindow: 4096 }],
        modelOverrides: { other: { maxTokens: 0 } },
      },
    },
  };
  const raw = JSON.stringify(config);
  writeFileSync(filename, raw);
  const issues = preflightModelsConfig(filename);
  assert.deepEqual(
    issues.map((issue) => issue.path),
    [
      "/providers/broken/models/0/contextWindow",
      "/providers/broken/models/0/maxTokens",
      "/providers/valid/modelOverrides/other/maxTokens",
    ],
  );
  assert.ok(!JSON.stringify(issues).includes("PRIVATE_FIXTURE_KEY"));
  assert.equal(readFileSync(filename, "utf8"), raw);
  assert.deepEqual(readdirSync(root), ["models.json"]);
  const credentials = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("read only");
    },
    delete: async () => {},
  };
  const invalid = await ModelRuntime.create({ modelsPath: filename, credentials, refreshOnCreate: false });
  assert.ok(invalid.getError());
  assert.equal(invalid.getModel("valid", "good"), undefined);
  config.providers.broken.models[0].contextWindow = 4096;
  config.providers.broken.models[0].maxTokens = 1024;
  config.providers.valid.modelOverrides.other.maxTokens = 1024;
  assert.deepEqual(inspectModelsConfig(config), []);
  writeFileSync(filename, JSON.stringify(config));
  const valid = await ModelRuntime.create({ modelsPath: filename, credentials, refreshOnCreate: false });
  assert.equal(valid.getError(), undefined);
  assert.ok(valid.getModel("valid", "good"));
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/check-models-config.mjs", filename],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).valid, true);
  assert.deepEqual(readdirSync(root), ["models.json"]);
});

test("model config parsing matches SDK line comments, trailing commas and string literals without echoing malformed secrets", () => {
  const config = parseModelsConfig(
    '\ufeff{ // comment\n "providers": {"fixture": {"apiKey": "https://example.test/a,//keep", "models": [{"id": "q\\"x",},],},},}',
  );
  assert.equal(config.providers.fixture.apiKey, "https://example.test/a,//keep");
  assert.deepEqual(inspectModelsConfig(config), []);
  for (const text of [
    '{"apiKey": "SECRET_DO_NOT_ECHO", invalid}',
    "null",
    "[]",
    '{/* not supported by Pi */"providers":{}}',
  ])
    assert.throws(
      () => parseModelsConfig(text),
      (error) => error.code === "PARSE_ERROR" && !error.message.includes("SECRET_DO_NOT_ECHO"),
    );
});
