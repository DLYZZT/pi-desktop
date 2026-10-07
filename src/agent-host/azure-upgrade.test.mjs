import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
const {
  planAzureDocument,
  ensureAzureUpgrade,
  azureUpgradeRevision,
  withLockedJsonFile,
  CredentialMutations,
  createDesktopAgentSessionServices,
} = await importTestBundle("azure-upgrade", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export * from './azure-upgrade.ts';
    export {withLockedJsonFile} from '../shared/node/locked-json-file.ts';
    export {CredentialMutations} from './credential-mutations.ts';
    export {createDesktopAgentSessionServices} from './desktop-session-services.ts';`,
  },
});
const old = "azure-openai-responses";
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-azure-upgrade-")),
    agent = path.join(root, "agent"),
    cwd = path.join(root, "project");
  mkdirSync(agent);
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return { root, agent, cwd, write };
}
test("Azure migration changes provider identities and typed references, preserving API IDs, secrets and sampling fields", () => {
  const model = {
    api: old,
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "gpt-6.1-sol",
        api: old,
        samplingParamsByThinkingLevel: { high: { temperature: 0.25 } },
        compat: { allowedFallbackModels: [{ provider: old, model: "gpt-6.1-sol" }] },
      },
    ],
    future: { provider: old },
  };
  const source = { providers: { [old]: model }, notes: old };
  const result = planAzureDocument("models", source);
  assert.equal(result.value.providers.azure.api, old);
  assert.equal(result.value.providers.azure.models[0].api, old);
  assert.equal(result.value.providers.azure.models[0].compat.allowedFallbackModels[0].provider, "azure");
  assert.deepEqual(result.value.providers.azure.models[0].samplingParamsByThinkingLevel, {
    high: { temperature: 0.25 },
  });
  assert.equal(result.value.providers.azure.future.provider, old);
  assert.equal(result.value.notes, old);
  assert.equal(source.providers[old], model);
  const settings = planAzureDocument("settings", {
    defaultProvider: old,
    enabledModels: [old + "/*:high", "anthropic/*"],
    modelThinkingLevels: { [old + "/gpt-6.1-sol"]: "high" },
    compaction: { modelOverrides: { [old + "/*"]: { reserveTokens: 123 } } },
    future: old,
  });
  assert.deepEqual(settings.value.enabledModels, ["azure/*:high", "anthropic/*"]);
  assert.equal(settings.value.modelThinkingLevels["azure/gpt-6.1-sol"], "high");
  assert.equal(settings.value.compaction.modelOverrides["azure/*"].reserveTokens, 123);
  assert.equal(settings.value.future, old);
});
test("global credentials, models, MCP auth references and trusted project preferences migrate with exact private backups", async (t) => {
  const f = fixture(t);
  f.write(path.join(f.agent, "auth.json"), {
    [old]: { type: "api_key", key: "PRIVATE_FIXTURE", env: { AZURE_OPENAI_BASE_URL: "https://fixture.invalid" } },
    other: { type: "api_key", key: "OTHER" },
  });
  f.write(path.join(f.agent, "models.json"), { providers: { [old]: { api: old, models: [] } } });
  f.write(path.join(f.agent, "settings.json"), { defaultProvider: old, defaultModel: "gpt-6.1-sol", future: true });
  f.write(path.join(f.agent, "mcp.json"), {
    mcpServers: { fixture: { url: "https://fixture.invalid/mcp", auth: { provider: old } } },
  });
  const projectFile = path.join(f.cwd, ".pi/settings.json");
  f.write(projectFile, { defaultProvider: old, enabledModels: [old + "/gpt-6.1-sol"] });
  const before = new Map(
    ["auth.json", "models.json", "settings.json", "mcp.json"].map((name) => [
      path.join(f.agent, name),
      readFileSync(path.join(f.agent, name), "utf8"),
    ]),
  );
  const result = await ensureAzureUpgrade({ agentDir: f.agent, cwd: f.cwd, projectTrusted: false });
  assert.equal(result.status, "migrated");
  assert.equal(result.files.length, 4);
  assert.equal(result.backups.length, 4);
  result.backups.forEach((backup, index) => {
    assert.equal(readFileSync(backup, "utf8"), before.get(result.files[index]));
    if (process.platform !== "win32") assert.equal(statSync(backup).mode & 0o777, 0o600);
  });
  if (process.platform !== "win32")
    assert.equal(statSync(path.join(f.agent, "desktop-azure-backups")).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|OTHER/);
  assert.equal(JSON.parse(readFileSync(projectFile)).defaultProvider, old);
  assert.equal(JSON.parse(readFileSync(path.join(f.agent, "auth.json"))).azure.key, "PRIVATE_FIXTURE");
  assert.equal(JSON.parse(readFileSync(path.join(f.agent, "auth.json"))).other.key, "OTHER");
  assert.equal(JSON.parse(readFileSync(path.join(f.agent, "mcp.json"))).mcpServers.fixture.auth.provider, "azure");
  await ensureAzureUpgrade({ agentDir: f.agent, cwd: f.cwd, projectTrusted: true });
  assert.equal(JSON.parse(readFileSync(projectFile)).defaultProvider, "azure");
  const revision = azureUpgradeRevision(f.agent),
    count = readdirSync(path.join(f.agent, "desktop-azure-backups")).length;
  await ensureAzureUpgrade({ agentDir: f.agent, cwd: f.cwd, projectTrusted: true });
  assert.equal(azureUpgradeRevision(f.agent), revision);
  assert.equal(readdirSync(path.join(f.agent, "desktop-azure-backups")).length, count);
});
test("conflicting credentials and preference keys preserve every file until explicitly resolved", async (t) => {
  const f = fixture(t),
    authFile = path.join(f.agent, "auth.json"),
    settingsFile = path.join(f.agent, "settings.json");
  f.write(authFile, { [old]: { type: "api_key", key: "OLD" }, azure: { type: "api_key", key: "CURRENT" } });
  f.write(settingsFile, { defaultProvider: old, modelThinkingLevels: { [old + "/gpt"]: "high", "azure/gpt": "low" } });
  const a = readFileSync(authFile, "utf8"),
    s = readFileSync(settingsFile, "utf8");
  const result = await ensureAzureUpgrade({ agentDir: f.agent });
  assert.equal(result.status, "review");
  assert.equal(result.files.length, 0);
  assert.equal(result.backups.length, 0);
  assert.equal(readFileSync(authFile, "utf8"), a);
  assert.equal(readFileSync(settingsFile, "utf8"), s);
  f.write(authFile, { azure: { type: "api_key", key: "CURRENT" } });
  f.write(settingsFile, { defaultProvider: "azure" });
  assert.equal(
    (await ensureAzureUpgrade({ agentDir: f.agent })).status,
    "unchanged",
    "a resolved conflict does not leave a sticky review state",
  );
});
test("split credential/config identities are not combined and identical duplicates are safely deduplicated", async (t) => {
  const f = fixture(t),
    authFile = path.join(f.agent, "auth.json"),
    modelsFile = path.join(f.agent, "models.json");
  f.write(authFile, { [old]: { type: "api_key", key: "LEGACY" } });
  f.write(modelsFile, { providers: { azure: { baseUrl: "https://new.invalid", api: old } } });
  assert.equal((await ensureAzureUpgrade({ agentDir: f.agent })).status, "review");
  assert.equal(JSON.parse(readFileSync(authFile))[old].key, "LEGACY");
  f.write(authFile, { [old]: { type: "api_key", key: "SAME" }, azure: { type: "api_key", key: "SAME" } });
  f.write(modelsFile, { providers: { [old]: { api: old }, azure: { api: old } } });
  assert.equal((await ensureAzureUpgrade({ agentDir: f.agent })).status, "migrated");
  assert.equal(JSON.parse(readFileSync(authFile))[old], undefined);
  assert.equal(JSON.parse(readFileSync(authFile)).azure.key, "SAME");
});
test("migration waits for credential locks and refuses stale credential dialogs after a rename", async (t) => {
  const f = fixture(t),
    authFile = path.join(f.agent, "auth.json");
  f.write(authFile, { [old]: { type: "api_key", key: "BEFORE" } });
  const mutation = new CredentialMutations(authFile),
    snapshot = await mutation.snapshot(old),
    entered = createDeferred(),
    release = createDeferred();
  const held = withLockedJsonFile(authFile, async (data, save) => {
    entered.resolve();
    await release.promise;
    data[old].key = "ROTATED";
    await save(data);
  });
  await entered.promise;
  const migration = ensureAzureUpgrade({ agentDir: f.agent });
  release.resolve();
  await held;
  assert.equal((await migration).status, "migrated");
  assert.equal(JSON.parse(readFileSync(authFile)).azure.key, "ROTATED");
  await assert.rejects(
    mutation.logout(
      {
        refresh() {
          throw new Error("must not refresh");
        },
      },
      old,
      "api_key",
      snapshot.version,
    ),
    (error) => error.code === "CONFLICT",
  );
  assert.equal(JSON.parse(readFileSync(authFile)).azure.key, "ROTATED");
});
test("backup failure and malformed input never overwrite configuration; absent files remain absent", async (t) => {
  const f = fixture(t),
    authFile = path.join(f.agent, "auth.json");
  await ensureAzureUpgrade({ agentDir: f.agent });
  assert.equal(existsSync(authFile), false);
  f.write(authFile, { [old]: { type: "api_key", key: "FIXTURE" } });
  const before = readFileSync(authFile, "utf8");
  writeFileSync(path.join(f.agent, "desktop-azure-backups"), "occupied");
  assert.equal((await ensureAzureUpgrade({ agentDir: f.agent })).status, "review");
  assert.equal(readFileSync(authFile, "utf8"), before);
  writeFileSync(authFile, "{broken");
  assert.equal((await ensureAzureUpgrade({ agentDir: f.agent })).status, "review");
  assert.equal(readFileSync(authFile, "utf8"), "{broken");
});

test("catalog-only services leave project preferences unchanged until the writable session path opts in", async (t) => {
  const f = fixture(t),
    projectFile = path.join(f.cwd, ".pi/settings.json");
  f.write(path.join(f.agent, "auth.json"), { azure: { type: "api_key", key: "FIXTURE" } });
  f.write(projectFile, { defaultProvider: old, defaultModel: "gpt-6.1-sol" });
  const before = readFileSync(projectFile, "utf8");
  const options = {
    cwd: f.cwd,
    agentDir: f.agent,
    resourceLoaderOptions: { noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true },
  };
  await createDesktopAgentSessionServices(options);
  assert.equal(readFileSync(projectFile, "utf8"), before);
  const services = await createDesktopAgentSessionServices(options, { project: true });
  assert.equal(services.azureUpgrade.status, "migrated");
  assert.equal(JSON.parse(readFileSync(projectFile)).defaultProvider, "azure");
});
