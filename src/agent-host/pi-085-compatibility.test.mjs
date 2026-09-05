import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { EXCLUDED_PI_TOOLS, validateDesktopToolNames, filterDesktopToolNames } from "../shared/pi-tool-policy.ts";
import { readSessionSnapshot, assertSessionWritable } from "./session-readonly.ts";
const { DesktopSessionToolStore, ChannelConfigStore } = await importTestBundle("pi-085-stores", {
  packages: "external",
  stdin: {
    contents:
      'export { DesktopSessionToolStore } from "./session-tool-store.ts"; export { ChannelConfigStore } from "./channels/config-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

const { withExtensionTools, AgentSessionWrapper } = await importTestBundle("pi-085-tool-policy", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "rpc-manager.ts")],
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-085-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Desktop selections reject unsupported tools and preserve ordinary extension tools", async () => {
  const inner = { getAllTools: () => ["read", "bash", "powershell", "extension"].map((name) => ({ name })) };
  assert.deepEqual(withExtensionTools(inner, ["read"]), ["read", "extension"]);
  assert.deepEqual(withExtensionTools(inner, []), []);
  assert.throws(
    () => validateDesktopToolNames([" powershell "]),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.throws(() => validateDesktopToolNames([1]), /array of strings/);
  assert.deepEqual(filterDesktopToolNames(["powershell", " read ", "read"]), ["read"]);
  let persisted = false;
  const wrapper = new AgentSessionWrapper({ agent: {}, sessionId: "fixture" }, undefined, () => {
    persisted = true;
  });
  try {
    await assert.rejects(wrapper.send({ type: "set_tools", toolNames: ["powershell"] }), /not supported/);
    assert.equal(persisted, false);
  } finally {
    wrapper.destroy();
  }
});

test("SDK denylist survives defaultTools, same-name extension activation and reload", async (t) => {
  const directory = fixture(t);
  const events = [];
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: ["powershell"] }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "policy-check",
          factory(pi) {
            pi.on("session_start", () => pi.setActiveTools(["powershell", "read"]));
            pi.on("ui_prompt_start", () => events.push("start"));
            pi.on("ui_prompt_end", () => events.push("end"));
          },
        },
      ],
    },
  });
  const tools = [
    {
      name: "powershell",
      label: "PowerShell override",
      description: "must not be executable",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("must not execute");
      },
    },
  ];
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    excludeTools: [...EXCLUDED_PI_TOOLS],
    customTools: tools,
  });
  t.after(() => session.dispose());
  const check = () => {
    assert.equal(
      session.getAllTools().some((tool) => tool.name === "powershell"),
      false,
    );
    session.setActiveToolsByName(["powershell", "read"]);
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
  };
  check();
  await session.bindExtensions({ mode: "rpc" });
  check();
  await session.reload();
  check();
  const runner = session.extensionRunner;
  const ui = runner.getUIContext();
  runner.setUIContext({ ...ui, confirm: async () => true }, "rpc");
  assert.equal(await runner.getUIContext().confirm("fixture", "continue"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start", "end"]);
});

test("legacy Desktop and Channel permissions are filtered without rewriting their source", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "tools.json");
  const raw = JSON.stringify({
    version: 1,
    sessions: { fixture: { toolNames: ["powershell", "read"], updatedAt: "fixture" } },
  });
  writeFileSync(file, raw);
  const store = new DesktopSessionToolStore(file);
  assert.deepEqual(store.get("fixture"), ["read"]);
  assert.equal(readFileSync(file, "utf8"), raw);
  store.set("fixture", ["powershell", "read"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sessions.fixture.toolNames, ["read"]);
  const channelFile = path.join(directory, "channels.json");
  const account = { id: "fixture", channel: "telegram", toolNames: ["powershell", "read"] };
  const channelRaw = JSON.stringify({ version: 1, accounts: [account], bindings: [] });
  writeFileSync(channelFile, channelRaw);
  const channels = new ChannelConfigStore(channelFile);
  assert.deepEqual(channels.getAccount("fixture").toolNames, ["read"]);
  assert.equal(readFileSync(channelFile, "utf8"), channelRaw);
  assert.throws(() => channels.upsertAccount(account), /not supported/);
  assert.throws(() => channels.upsertBinding({ toolNames: ["powershell"] }), /not supported/);
  assert.equal(readFileSync(channelFile, "utf8"), channelRaw);
});

test("read-only JSONL projection preserves header, labels, compaction and original bytes", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "history.jsonl");
  const timestamp = "2026-09-04T00:00:00.000Z";
  const entries = [
    { type: "session", version: 3, id: "fixture", cwd: directory, timestamp, parentSession: "/parent.jsonl" },
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "你好 🌍", timestamp: 1 },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "user",
      timestamp,
      summary: "Earlier work",
      firstKeptEntryId: "user",
      tokensBefore: 100,
    },
    { type: "session_info", id: "name", parentId: "compact", timestamp, name: "Read-only history" },
    { type: "label", id: "label", parentId: "name", timestamp, targetId: "user", label: "bookmark" },
  ];
  const raw = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(file, raw);
  if (process.platform !== "win32") chmodSync(file, 0o444);
  const before = statSync(file);
  const snapshot = readSessionSnapshot(file);
  assert.equal(snapshot.isPersisted(), false);
  assert.equal(snapshot.getSessionFile(), undefined);
  assert.equal(snapshot.getSessionId(), "fixture");
  assert.equal(snapshot.getCwd(), directory);
  assert.equal(snapshot.getHeader().parentSession, "/parent.jsonl");
  assert.equal(snapshot.getSessionName(), "Read-only history");
  assert.equal(snapshot.getLeafId(), "label");
  assert.equal(snapshot.getLabel("user"), "bookmark");
  assert.deepEqual(snapshot.getEntries(), entries.slice(1));
  assert.match(JSON.stringify(snapshot.buildSessionContext()), /Earlier work/);
  assert.equal(readFileSync(file, "utf8"), raw);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(statSync(file).mode, before.mode);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    assert.throws(() => assertSessionWritable(file), /read-only/);
  }
  chmodSync(file, 0o600);
  assertSessionWritable(file);
  const writable = SessionManager.open(file);
  writable.appendSessionInfo("renamed");
  assert.equal(readSessionSnapshot(file).getSessionName(), "renamed");
});

test("invalid, duplicate and future headers cannot silently become new sessions", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "invalid.jsonl");
  for (const raw of [
    "",
    "not JSON",
    "null",
    '{"type":"message"}',
    '{"type":"session","id":"future","version":99}',
    '{"type":"session","id":"one"}\n{"type":"session","id":"two"}',
  ]) {
    writeFileSync(file, raw);
    assert.throws(() => readSessionSnapshot(file), /header|version|entry/);
    assert.equal(readFileSync(file, "utf8"), raw);
  }
});

test("fork after compaction preserves both the context boundary and Desktop no-tools selection", async (t) => {
  const directory = fixture(t);
  const manager = SessionManager.create(directory, directory);
  const userId = manager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "old answer" }],
    timestamp: 2,
    provider: "test",
    model: "test",
    api: "test",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendCompaction("context summary", userId, 500);
  const forkAt = manager.appendMessage({ role: "user", content: "after compaction", timestamp: 3 });
  const persisted = [];
  const wrapper = new AgentSessionWrapper(
    {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      sessionManager: manager,
      agent: { state: {} },
      abort: async () => {},
      getActiveToolNames: () => [],
    },
    [],
    (id, tools) => persisted.push({ id, tools }),
  );
  const result = await wrapper.send({ type: "fork", entryId: forkAt });
  assert.deepEqual(persisted, [{ id: result.newSessionId, tools: [] }]);
  const child = (await SessionManager.list(directory, directory)).find((item) => item.id === result.newSessionId);
  assert.ok(child);
  const restored = readSessionSnapshot(child.path);
  assert.equal(restored.getHeader().parentSession, manager.getSessionFile());
  assert.match(JSON.stringify(restored.buildSessionContext()), /context summary/);
  assert.equal(
    restored.getEntries().some((entry) => entry.id === forkAt),
    false,
  );
});
