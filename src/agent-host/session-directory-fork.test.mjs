import assert from "node:assert/strict";
import { fork as forkProcess } from "node:child_process";
import { once } from "node:events";
import fs, {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
import lockfile from "proper-lockfile";

const root = mkdtempSync(path.join(tmpdir(), "pi-fork-folder-test-"));
const sessions = path.join(root, "custom-sessions");
const desktop = path.join(root, "desktop");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
process.env.PI_DESKTOP_USER_DATA = desktop;
process.env.PI_OFFLINE = "1";
mkdirSync(sessions);
const policyFile = path.join(desktop, "session-tools.json");
const historyRoot = path.join(desktop, "tool-executions");
mkdirSync(historyRoot, { recursive: true });
writeFileSync(policyFile, JSON.stringify({ version: 1, sessions: {} }));
test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  createSessionHandlers,
  ExecutionLogStore,
  getDefaultStore,
  loadSessionToolSelection,
  activateInitialSessionTools,
  SessionToolPolicy,
  setAgentSessionSource,
  workerModule,
  recoverInterruptedDirectoryForks,
  DirectoryForkWorkspace,
  guardSessionCacheWarming,
} = await importTestBundle("session-directory-fork", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `export { createSessionHandlers } from "./handlers/sessions.ts";
      export { ExecutionLogStore } from "./execution-log-store.ts";
      export { getDefaultStore } from "./session-tool-store.ts";
      export { loadSessionToolSelection } from "./session-shell.ts";
      export { activateInitialSessionTools } from "./session-tool-settings.ts";
      export { SessionToolPolicy } from "./session-tool-policy.ts";
      export { setAgentSessionSource } from "./session-source.ts";
      export { forkSessionToDirectory } from "./session-directory-fork.ts";
      export { recoverInterruptedDirectoryForks } from "./session-fork-workspace.ts";
      export { DirectoryForkWorkspace } from "./session-fork-workspace.ts";
      export { guardSessionCacheWarming } from "./session-cache-warming.ts";
      export const workerModule = import.meta.url;`,
  },
});

function fixture(emit) {
  const projects = mkdtempSync(path.join(root, "projects-"));
  const sourceDirectory = path.join(projects, "original");
  const destination = path.join(projects, "new");
  mkdirSync(sourceDirectory);
  mkdirSync(destination);
  const manager = SessionManager.create(sourceDirectory, sessions);
  manager.appendSessionInfo("Existing conversation");
  manager.appendModelChange("openai", "fixture-model");
  const timestamp = Date.now();
  const user = manager.appendMessage({ role: "user", content: "Earlier question", timestamp });
  const assistant = (text) => ({
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "fixture-model",
    content: [{ type: "text", text }],
    timestamp,
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  });
  const earlierBranch = manager.appendMessage(assistant("Earlier branch"));
  manager.branch(user);
  const currentBranch = manager.appendMessage(assistant("Current branch"));
  renameSync(sourceDirectory, path.join(projects, "moved"));
  const events = [];
  const handlers = createSessionHandlers({
    server: { emit: emit ?? ((...event) => events.push(event)) },
    managedProcesses: { activeForSession: () => [], stop() {} },
    clearSessionEventBinding() {},
  });
  const id = manager.getSessionId();
  const filename = manager.getSessionFile();
  return { id, filename, destination, earlierBranch, currentBranch, bytes: readFileSync(filename), handlers, events };
}

function execution(anchorEntryId, id, result) {
  return {
    executionId: id,
    runId: "old-run",
    toolCallId: id,
    rootToolCallId: id,
    anchorEntryId,
    source: "local",
    toolName: "read",
    status: "succeeded",
    requestedAt: 1,
    endedAt: 2,
    result,
  };
}

test("forking to a new directory preserves the entire source tree and execution outputs with fresh permissions", async () => {
  const f = fixture();
  const sourceStore = new ExecutionLogStore(f.id);
  const output = { text: "Earlier tool output ".repeat(10000) };
  const payload = await sourceStore.payload(output);
  assert.ok(payload.ref);
  await sourceStore.append(execution(f.earlierBranch, "old-branch", payload));
  await sourceStore.append(execution(f.currentBranch, "current-branch", { value: { text: "Current tool output" } }));
  const toolStore = getDefaultStore();
  toolStore.set(f.id, ["read", "mcp__fixture__lookup"]);
  toolStore.setExecution(f.id, ["mcp__fixture__lookup"]);
  const sourceGrants = toolStore.getExecution(f.id);
  assert.deepEqual(sourceGrants, ["mcp__fixture__lookup"]);

  const fork = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  assert.notEqual(fork.id, f.id);
  assert.equal(fork.cwd, realpathSync(f.destination));
  assert.equal(fork.parentSessionId, f.id);
  assert.equal(fork.name, "Existing conversation");
  assert.equal(path.dirname(fork.path), sessions);
  const manager = SessionManager.open(fork.path);
  assert.equal(manager.getHeader().parentSession, f.filename);
  assert.deepEqual(manager.getEntries(), SessionManager.open(f.filename).getEntries());
  assert.deepEqual(readFileSync(f.filename), f.bytes);

  const forkDetails = await f.handlers.get({ id: fork.id, includeState: true });
  assert.deepEqual(forkDetails.toolNames, []);
  assert.equal(forkDetails.unavailableWorkingDirectory, undefined);
  assert.equal(forkDetails.agentState.running, false);
  assert.deepEqual(toolStore.getExecution(fork.id), []);
  assert.deepEqual(toolStore.getExecution(f.id), sourceGrants);
  const copiedStore = new ExecutionLogStore(fork.id);
  const copied = await copiedStore.readLatest();
  assert.deepEqual(
    copied.records.map((record) => record.executionId),
    ["current-branch", "old-branch"],
  );
  assert.deepEqual(await copiedStore.readContent(payload.ref.hash, payload.ref.bytes), output);
  assert.ok(
    f.events.some(
      ([topic, id, event]) => topic === "sessions.changed" && id === fork.id && event.session?.cwd === fork.cwd,
    ),
  );
});

test("unavailable, relative and non-directory destinations leave the source session untouched", async () => {
  const f = fixture();
  const before = readdirSync(sessions).sort();
  const file = path.join(f.destination, "not-a-folder.txt");
  writeFileSync(file, "fixture");
  for (const cwd of ["relative-folder", path.join(f.destination, "missing"), file]) {
    await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd }), { code: "SESSION_FORK_TARGET_UNAVAILABLE" });
  }
  assert.deepEqual(readdirSync(sessions).sort(), before);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
  assert.deepEqual(f.events, []);
});

test("a failed copy rolls back execution records and never publishes a fork", async () => {
  const f = fixture();
  const store = new ExecutionLogStore(f.id);
  await store.append(execution(f.earlierBranch, "valid-output", { value: { text: "Historical content" } }));
  await store.append(execution(f.currentBranch, "missing-output", { ref: { hash: "a".repeat(64), bytes: 32 } }));
  const historyDirectory = path.join(desktop, "tool-executions");
  const journals = readdirSync(historyDirectory).sort();
  const files = readdirSync(sessions).sort();
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), /ENOENT/);
  assert.deepEqual(readdirSync(sessions).sort(), files);
  assert.deepEqual(readdirSync(historyDirectory).sort(), journals);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
  assert.deepEqual(f.events, []);
});

function forceForkId(t, id) {
  const forkFrom = SessionManager.forkFrom;
  t.mock.method(SessionManager, "forkFrom", (source, target, storage) => forkFrom(source, target, storage, { id }));
}

test("fork reads a complete final JSONL record without a newline, including from a read-only source", async () => {
  const f = fixture();
  const bytes = Buffer.from(f.bytes.toString("utf8").trimEnd());
  writeFileSync(f.filename, bytes);
  for (const mode of process.platform === "win32" ? [0o600] : [0o600, 0o400]) {
    chmodSync(f.filename, mode);
    const before = statSync(f.filename, { bigint: true });
    const fork = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
    const reopened = SessionManager.open(fork.path);
    assert.equal(reopened.getHeader().parentSession, f.filename);
    assert.equal(reopened.getLeafId(), f.currentBranch);
    assert.deepEqual(readFileSync(f.filename), bytes);
    const after = statSync(f.filename, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    if (process.platform !== "win32") assert.equal(statSync(fork.path).mode & 0o777, 0o600);
  }
});

test("legacy entries gain valid branch IDs in the copy while the original v1 bytes stay intact", async () => {
  const f = fixture();
  const lines = f.bytes
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  lines[0].version = 1;
  for (const entry of lines.slice(1)) {
    delete entry.id;
    delete entry.parentId;
  }
  const bytes = Buffer.from(lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(f.filename, bytes);
  const fork = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  const reopened = SessionManager.open(fork.path);
  const entries = reopened.getEntries();
  assert.ok(entries.every((entry) => typeof entry.id === "string" && entry.id.length > 0));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.deepEqual(reopened.getBranch(), entries);
  assert.equal(reopened.getHeader().parentSession, f.filename);
  assert.deepEqual(readFileSync(f.filename), bytes);
});

test("a destination ID collision never edits or rolls back the original permissions, journal or content", async (t) => {
  const f = fixture();
  forceForkId(t, f.id);
  const policies = getDefaultStore();
  policies.set(f.id, ["read", "write"]);
  const original = new ExecutionLogStore(f.id);
  const payload = await original.payload("historical output".repeat(4000));
  await original.append(execution(f.currentBranch, "original", payload));
  const policyFile = path.join(desktop, "session-tools.json");
  const journal = path.join(desktop, "tool-executions", f.id + ".jsonl");
  const blob = path.join(desktop, "tool-executions", f.id, "content", payload.ref.hash + ".json");
  const files = [f.filename, journal, blob, policyFile];
  const before = files.map((filename) => readFileSync(filename));
  const sessionsBefore = readdirSync(sessions).sort();
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code: "CONFLICT" });
  assert.deepEqual(
    files.map((filename) => readFileSync(filename)),
    before,
  );
  assert.deepEqual(readdirSync(sessions).sort(), sessionsBefore);
  assert.deepEqual(f.events, []);
});

test("concurrent independent forks own distinct histories and start with no inherited tool authority", async () => {
  const f = fixture();
  const source = SessionManager.open(f.filename);
  source.appendCustomEntry("pi-desktop-session-tools", {
    version: 1,
    toolNames: ["read", "bash", "mcp__fixture__lookup"],
  });
  const sourceBytes = readFileSync(f.filename);
  const store = getDefaultStore();
  store.set(f.id, ["read", "bash", "mcp__fixture__lookup"]);
  store.setMcpExecution(f.id, ["mcp__fixture__lookup"]);
  const originalPolicy = JSON.parse(readFileSync(path.join(desktop, "session-tools.json"))).sessions[f.id];
  const sourceLog = new ExecutionLogStore(f.id);
  await sourceLog.append(execution(f.currentBranch, "source-call", { value: "source output" }));
  const journal = path.join(desktop, "tool-executions", f.id + ".jsonl");
  const journalBytes = readFileSync(journal);
  const forks = await Promise.all(
    Array.from({ length: 4 }, () => f.handlers.forkToDirectory({ id: f.id, cwd: f.destination })),
  );
  assert.equal(new Set(forks.map((fork) => fork.id)).size, forks.length);
  const persisted = JSON.parse(readFileSync(path.join(desktop, "session-tools.json"))).sessions;
  for (const fork of forks) {
    assert.deepEqual(persisted[fork.id].toolNames, []);
    assert.deepEqual(persisted[fork.id].orchestrationToolNames, []);
    assert.deepEqual(persisted[fork.id].mcpDeclarationToolNames, []);
    assert.deepEqual(persisted[fork.id].mcpExecutionToolNames, []);
    const manager = SessionManager.open(fork.path);
    const selection = await loadSessionToolSelection(manager, false);
    assert.deepEqual(selection.toolNames, []);
    setAgentSessionSource(manager, "local");
    const policy = new SessionToolPolicy(
      manager,
      selection.toolNames,
      store.getExecution(fork.id),
      store.getMcpExecution(fork.id),
    );
    const active = ["read", "bash", "codemode", "mcp__fixture__lookup"];
    policy.bind({ getActiveToolNames: () => active });
    for (const name of active) assert.equal(policy.isAllowed(name), false);
    assert.deepEqual(
      (await new ExecutionLogStore(fork.id).readLatest()).records.map((record) => record.sessionId),
      [fork.id],
    );
  }
  assert.deepEqual(readFileSync(f.filename), sourceBytes);
  assert.deepEqual(readFileSync(journal), journalBytes);
  assert.deepEqual(persisted[f.id], originalPolicy);
});

test("two overlapping forks assigned the same ID cannot remove or share the winner's state", async (t) => {
  const f = fixture();
  const id = "concurrent-fork-id";
  forceForkId(t, id);
  await new ExecutionLogStore(f.id).append(execution(f.currentBranch, "source-call", { value: 1 }));
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () => f.handlers.forkToDirectory({ id: f.id, cwd: f.destination })),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  assert.equal(successes.length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "CONFLICT");
  assert.deepEqual(getDefaultStore().get(id), []);
  assert.equal((await new ExecutionLogStore(id).readLatest()).records.length, 1);
  assert.equal(readFileSync(successes[0].value.path, "utf8").includes('"id":"' + id + '"'), true);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

test("a source changed while execution history is copying is rechecked before publication", async (t) => {
  const f = fixture();
  const entered = createDeferred(),
    resume = createDeferred();
  const originalCopy = ExecutionLogStore.prototype.copyBranch;
  t.mock.method(ExecutionLogStore.prototype, "copyBranch", async function (...args) {
    await originalCopy.apply(this, args);
    entered.resolve();
    await resume.promise;
  });
  const sessionsBefore = readdirSync(sessions).sort();
  const change =
    JSON.stringify({
      type: "session_info",
      id: "later",
      parentId: f.currentBranch,
      timestamp: new Date().toISOString(),
      name: "Changed by another writer",
    }) + "\n";
  const pending = f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  await Promise.race([entered.promise, pending]);
  appendFileSync(f.filename, change);
  resume.resolve();
  await assert.rejects(pending, { code: "CONFLICT" });
  assert.deepEqual(readFileSync(f.filename), Buffer.concat([f.bytes, Buffer.from(change)]));
  assert.deepEqual(readdirSync(sessions).sort(), sessionsBefore);
  assert.deepEqual(f.events, []);
});

test("a live source suspends cache warming during the actual fork and restores its mode on rollback", async (t) => {
  const f = fixture(),
    manager = SessionManager.open(f.filename);
  mkdirSync(manager.getCwd(), { recursive: true });
  const settings = { getCacheWarmingMode: () => "idle" };
  guardSessionCacheWarming(settings, manager);
  assert.equal(settings.getCacheWarmingMode(), "idle");
  t.mock.method(ExecutionLogStore.prototype, "copyBranch", async () => {
    assert.equal(settings.getCacheWarmingMode(), "off");
    throw new Error("copy interrupted");
  });
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), /copy interrupted/);
  assert.equal(settings.getCacheWarmingMode(), "idle");
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

test("a damaged final record requires confirmation for that exact source before copying the complete history", async () => {
  const f = fixture();
  appendFileSync(f.filename, '{"type":"message","id":');
  const bytes = readFileSync(f.filename);
  const files = readdirSync(sessions).sort();
  const params = { id: f.id, cwd: f.destination };
  let revision;
  const check = (error) => {
    assert.equal(error.code, "SESSION_FORK_INCOMPLETE_TAIL");
    assert.equal(error.detail.line, f.bytes.toString().split("\n").length);
    revision = error.detail.revision;
    assert.match(revision, /^[0-9a-f]{64}$/);
    return true;
  };
  await assert.rejects(f.handlers.forkToDirectory(params), check);
  assert.deepEqual(readFileSync(f.filename), bytes);
  assert.deepEqual(readdirSync(sessions).sort(), files);
  assert.deepEqual(f.events, []);
  const first = revision;
  appendFileSync(f.filename, '"updated');
  await assert.rejects(f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: first }), check);
  assert.notEqual(revision, first);
  const before = readFileSync(f.filename);
  const fork = await f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: revision });
  assert.deepEqual(
    SessionManager.open(fork.path).getEntries(),
    f.bytes
      .toString()
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((s) => JSON.parse(s)),
  );
  assert.deepEqual(getDefaultStore().get(fork.id), []);
  assert.deepEqual(readFileSync(f.filename), before);
});

test("a damaged interior line cannot be skipped by the tail-recovery option", async () => {
  const f = fixture();
  const lines = f.bytes.toString().trimEnd().split("\n");
  lines.splice(2, 0, '{"partial":');
  const bytes = Buffer.from(lines.join("\n") + "\n");
  writeFileSync(f.filename, bytes);
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination, confirmedIncompleteTail: "stale" }), {
    code: "SESSION_FORK_INVALID_HISTORY",
    detail: { line: 3 },
  });
  assert.deepEqual(f.events, []);
  assert.deepEqual(readFileSync(f.filename), bytes);
});

test("finishing a cold SDK startup cannot restore tools after a concurrent explicit revocation", async () => {
  const f = fixture(),
    store = getDefaultStore(),
    external = new store.constructor(policyFile);
  const manager = SessionManager.open(f.filename);
  manager.appendCustomEntry("pi-desktop-session-tools", { version: 1, toolNames: ["read", "bash"] });
  const initial = await loadSessionToolSelection(manager, false, undefined, true);
  assert.equal(initial.persistSelection, true);
  let active = ["read", "bash"],
    empty = false;
  const inner = {
    sessionId: f.id,
    getAllTools: () => [],
    getActiveToolNames: () => active,
    setActiveToolsByName: (names) => {
      active = names;
    },
  };
  const policy = new SessionToolPolicy(manager, initial.toolNames);
  const unlock = lockfile.lockSync(policyFile, { realpath: false });
  const starting = activateInitialSessionTools(inner, initial, policy, {
    setForceEmpty: (value) => {
      empty = value;
    },
  });
  unlock();
  await external.set(f.id, []);
  assert.deepEqual(await starting, []);
  assert.deepEqual(active, []);
  assert.equal(empty, true);
  assert.equal(policy.isEmpty(), true);
  assert.deepEqual(store.get(f.id), []);
});

test("a Fork after switching roots reads the selected store even with the former source still cached", async (t) => {
  const f = fixture(),
    previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  t.after(() => {
    process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  });
  await f.handlers.get({ id: f.id });
  const current = mkdtempSync(path.join(root, "current-sessions-")),
    file = path.join(current, path.basename(f.filename));
  fs.copyFileSync(f.filename, file);
  const manager = SessionManager.open(file);
  manager.appendSessionInfo("Current store");
  const bytes = readFileSync(file);
  process.env.PI_CODING_AGENT_SESSION_DIR = current;
  const fork = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  assert.equal(fork.name, "Current store");
  assert.equal(SessionManager.open(fork.path).getHeader().parentSession, file);
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

test("an old tail confirmation cannot publish after a different writer repairs the source", async () => {
  const f = fixture(),
    params = { id: f.id, cwd: f.destination };
  appendFileSync(f.filename, '{"type":"session_info","id":"repair"');
  let confirmation;
  await assert.rejects(f.handlers.forkToDirectory(params), (error) => {
    assert.equal(error.code, "SESSION_FORK_INCOMPLETE_TAIL");
    confirmation = error.detail.revision;
    return true;
  });
  appendFileSync(f.filename, ',"parentId":null,"timestamp":"2026-11-23T12:00:00Z","name":"Repaired"}\n');
  const repaired = readFileSync(f.filename),
    originalStat = statSync(f.filename, { bigint: true });
  const policies = readFileSync(policyFile),
    files = readdirSync(sessions).sort(),
    history = readdirSync(historyRoot).sort();
  await assert.rejects(f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: confirmation }), {
    code: "SESSION_FORK_SOURCE_CHANGED",
  });
  assert.deepEqual(readFileSync(f.filename), repaired);
  assert.equal(statSync(f.filename, { bigint: true }).mtimeNs, originalStat.mtimeNs);
  assert.deepEqual(readFileSync(policyFile), policies);
  assert.deepEqual(readdirSync(sessions).sort(), files);
  assert.deepEqual(readdirSync(historyRoot).sort(), history);
  assert.deepEqual(f.events, []);
  const fork = await f.handlers.forkToDirectory(params);
  assert.equal(SessionManager.open(fork.path).getLeafId(), "repair");
  assert.deepEqual(readFileSync(f.filename), repaired);
});

test("an explicit permission decision made while a legacy branch is attaching wins over copied tool names", async () => {
  const f = fixture(),
    parent = SessionManager.open(f.filename);
  parent.appendCustomEntry("pi-desktop-session-tools", { version: 1, toolNames: ["read", "bash"] });
  const branch = SessionManager.forkFrom(f.filename, parent.getCwd(), sessions),
    id = branch.getSessionId(),
    store = getDefaultStore();
  const external = new store.constructor(policyFile);
  const lock = lockfile.lockSync(policyFile, { realpath: false });
  const opening = loadSessionToolSelection(branch, false, undefined, true);
  lock();
  await external.set(id, []);
  const selected = await opening;
  assert.deepEqual(selected.toolNames, []);
  assert.equal(selected.persistSelection, false);
  assert.deepEqual(store.get(id), []);
});

test("blank lines or a CRLF after a damaged final record do not prevent explicit tail recovery", async () => {
  const f = fixture();
  appendFileSync(f.filename, '{"partial":\r\n\r\n');
  const bytes = readFileSync(f.filename),
    params = { id: f.id, cwd: f.destination };
  let revision;
  await assert.rejects(f.handlers.forkToDirectory(params), (error) => {
    assert.equal(error.code, "SESSION_FORK_INCOMPLETE_TAIL");
    revision = error.detail.revision;
    return true;
  });
  const fork = await f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: revision });
  assert.equal(SessionManager.open(fork.path).getLeafId(), f.currentBranch);
  assert.deepEqual(readFileSync(f.filename), bytes);
});

test("tail recovery leaves the original inode, aliases, permissions and execution log alone across a contended publish", async (t) => {
  const f = fixture(),
    params = { id: f.id, cwd: f.destination },
    store = getDefaultStore();
  store.set(f.id, ["read", "bash"]);
  await new ExecutionLogStore(f.id).append(execution(f.currentBranch, "from-original", { value: "existing history" }));
  const journal = path.join(historyRoot, f.id + ".jsonl"),
    originalLog = readFileSync(journal),
    originalPolicy = readFileSync(policyFile);
  const incomplete = Buffer.from('{"type":"session_info","id":"edited"');
  appendFileSync(f.filename, incomplete);
  let revision;
  await assert.rejects(f.handlers.forkToDirectory(params), (error) => {
    revision = error.detail?.revision;
    return error.code === "SESSION_FORK_INCOMPLETE_TAIL";
  });
  const entered = createDeferred(),
    install = store.publishChatOnlyFork.bind(store);
  t.mock.method(store, "publishChatOnlyFork", (...args) => {
    const work = install(...args);
    entered.resolve();
    return work;
  });
  const unlock = lockfile.lockSync(policyFile, { realpath: false });
  const beforeFiles = readdirSync(sessions).sort(),
    beforeLogs = readdirSync(historyRoot).sort();
  const pending = f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: revision });
  try {
    await Promise.race([entered.promise, pending]);
    appendFileSync(f.filename, ',"parentId":null,"timestamp":"2026-11-23T10:00:00Z","name":"Independent change"}\n');
  } finally {
    unlock();
  }
  const edited = readFileSync(f.filename);
  await assert.rejects(pending, { code: "SESSION_FORK_SOURCE_CHANGED" });
  assert.deepEqual(readFileSync(f.filename), edited);
  assert.deepEqual(readFileSync(policyFile), originalPolicy);
  assert.deepEqual(readFileSync(journal), originalLog);
  assert.deepEqual(readdirSync(sessions).sort(), beforeFiles);
  assert.deepEqual(readdirSync(historyRoot).sort(), beforeLogs);

  appendFileSync(f.filename, '{"type":');
  const alias = path.join(f.destination, "original-history.copy");
  fs.linkSync(f.filename, alias);
  if (process.platform !== "win32") chmodSync(f.filename, 0o444);
  const bytes = readFileSync(f.filename),
    stat = statSync(f.filename, { bigint: true });
  await assert.rejects(f.handlers.forkToDirectory(params), (error) => {
    revision = error.detail?.revision;
    return error.code === "SESSION_FORK_INCOMPLETE_TAIL";
  });
  const copy = await f.handlers.forkToDirectory({ ...params, confirmedIncompleteTail: revision });
  assert.equal(SessionManager.open(copy.path).getLeafId(), "edited");
  assert.deepEqual(readFileSync(f.filename), bytes);
  assert.deepEqual(readFileSync(alias), bytes);
  const after = statSync(f.filename, { bigint: true });
  for (const key of ["dev", "ino", "mode", "mtimeNs", "ctimeNs", "size", "nlink"]) assert.equal(after[key], stat[key]);
  assert.deepEqual(readFileSync(journal), originalLog);
  assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[f.id], JSON.parse(originalPolicy).sessions[f.id]);
});

test("independent Host processes sharing the permissions file publish all concurrent forks", async (t) => {
  const f = fixture(),
    store = getDefaultStore();
  store.set(f.id, ["read", "edit"]);
  const doc = JSON.parse(readFileSync(policyFile));
  doc.sessions[f.id].futureField = { untouched: true };
  writeFileSync(policyFile, JSON.stringify(doc));
  const workerPath = path.join(root, "fork-worker.mjs");
  writeFileSync(
    workerPath,
    `
    try {
      const { forkSessionToDirectory } = await import(process.argv[2]);
      process.once("message", async (params) => {
        try { process.send({ fork: await forkSessionToDirectory(params) }); }
        catch (error) { process.send({ error: error.stack }); }
        finally { process.disconnect(); }
      });
      process.send("ready");
    } catch (error) { process.send({ error: error.stack }); process.disconnect(); }
  `,
  );
  const workers = Array.from({ length: 3 }, () =>
    forkProcess(workerPath, [workerModule], { execArgv: [], silent: true }),
  );
  t.after(() => workers.forEach((worker) => worker.kill()));
  const exits = Promise.all(workers.map((worker) => once(worker, "exit")));
  const ready = await Promise.all(workers.map((worker) => once(worker, "message")));
  for (const [message] of ready) assert.equal(message, "ready", message.error);
  const answers = Promise.all(workers.map((worker) => once(worker, "message")));
  workers.forEach((worker) => worker.send({ id: f.id, cwd: f.destination }));
  const forks = (await answers).map(([result]) => {
    assert.ok(result.fork, result.error);
    return result.fork;
  });
  assert.ok((await exits).every(([code]) => code === 0));
  assert.equal(new Set(forks.map((fork) => fork.id)).size, workers.length);
  for (const fork of forks) {
    assert.equal(SessionManager.open(fork.path).getHeader().parentSession, f.filename);
    assert.deepEqual(store.get(fork.id), []);
    assert.deepEqual(store.getExecution(fork.id), []);
  }
  assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[f.id], doc.sessions[f.id]);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

for (const occupied of ["journal", "blob directory", "policy row"]) {
  test(`an existing ${occupied} blocks a fork even without a corresponding transcript`, async (t) => {
    const f = fixture(),
      id = "occupied-" + occupied.replaceAll(" ", "-");
    forceForkId(t, id);
    const journal = path.join(historyRoot, id + ".jsonl"),
      directory = path.join(historyRoot, id);
    let protectedFile = policyFile;
    if (occupied === "journal") {
      mkdirSync(historyRoot, { recursive: true });
      writeFileSync(journal, "existing journal", { flag: "wx" });
      protectedFile = journal;
    } else if (occupied === "blob directory") {
      mkdirSync(directory, { recursive: true });
      protectedFile = path.join(directory, "original");
      writeFileSync(protectedFile, "existing evidence");
    } else {
      getDefaultStore().set(id, ["read", "edit"]);
    }
    const bytes = readFileSync(protectedFile),
      files = readdirSync(sessions).sort(),
      history = readdirSync(historyRoot).sort();
    await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code: "CONFLICT" });
    assert.deepEqual(readFileSync(protectedFile), bytes);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readdirSync(sessions).sort(), files);
    assert.deepEqual(readdirSync(historyRoot).sort(), history);
    assert.deepEqual(f.events, []);
  });
}

test("a late destination conflict restores the exact policy file and preserves the occupying transcript", async (t) => {
  const f = fixture(),
    id = "late-publish-conflict";
  forceForkId(t, id);
  const store = getDefaultStore();
  store.set(f.id, ["read", "edit"]);
  const doc = JSON.parse(readFileSync(policyFile));
  doc.sessions[f.id].futureGrantField = { provider: "source-owned" };
  const before = Buffer.from(JSON.stringify(doc) + "\n");
  writeFileSync(policyFile, before);
  const history = readdirSync(historyRoot).sort();
  const link = fs.linkSync;
  let occupied;
  t.mock.method(fs, "linkSync", (from, to) => {
    assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[id].executionToolNames, []);
    writeFileSync(to, "occupied after the first ID check", { flag: "wx" });
    occupied = to;
    return link(from, to);
  });
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code: "CONFLICT" });
  assert.equal(readFileSync(occupied, "utf8"), "occupied after the first ID check");
  assert.deepEqual(readFileSync(policyFile), before);
  assert.equal(store.get(id), undefined);
  assert.deepEqual(readdirSync(historyRoot).sort(), history);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
  assert.deepEqual(f.events, []);
});

for (const change of ["journal", "target directory", "claimed history"]) {
  test(`a late change to the ${change} cannot publish a mixed snapshot or delete the replacement`, async (t) => {
    const f = fixture(),
      id = "changed-" + change.replaceAll(" ", "-");
    forceForkId(t, id);
    const original = new ExecutionLogStore(f.id);
    await original.append(execution(f.currentBranch, "earlier", { value: 1 }));
    const sourceJournal = path.join(historyRoot, f.id + ".jsonl");
    let expectedJournal = readFileSync(sourceJournal);
    const journal = path.join(historyRoot, id + ".jsonl");
    const copy = ExecutionLogStore.prototype.copyBranch;
    t.mock.method(ExecutionLogStore.prototype, "copyBranch", async function (...args) {
      await copy.apply(this, args);
      if (change === "journal") {
        await original.append(execution(f.currentBranch, "external-update", { value: 2 }));
        expectedJournal = readFileSync(sourceJournal);
      } else if (change === "target directory") {
        renameSync(f.destination, f.destination + "-original");
        mkdirSync(f.destination);
      } else {
        renameSync(journal, journal + ".displaced");
        writeFileSync(journal, "independent history");
      }
    });
    const before = readdirSync(sessions).sort(),
      policies = readFileSync(policyFile);
    const code = change === "target directory" ? "SESSION_FORK_TARGET_UNAVAILABLE" : "CONFLICT";
    await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code });
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readFileSync(sourceJournal), expectedJournal);
    assert.deepEqual(readFileSync(policyFile), policies);
    assert.deepEqual(readdirSync(sessions).sort(), before);
    if (change === "claimed history") assert.equal(readFileSync(journal, "utf8"), "independent history");
    assert.deepEqual(f.events, []);
  });
}

test("the fork defaults to chat-only on reopen after permission loss, including copied legacy grants", async (t) => {
  const f = fixture(),
    source = SessionManager.open(f.filename),
    store = getDefaultStore();
  const parentTools = ["read", "bash", "mcp__fixture__lookup"];
  source.appendCustomEntry("pi-desktop-session-tools", { version: 1, toolNames: parentTools });
  const sourceBytes = readFileSync(f.filename);
  store.set(f.id, parentTools);
  const fork = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  const saved = readFileSync(policyFile);
  t.after(() => writeFileSync(policyFile, saved));
  const doc = JSON.parse(saved);
  const parentGrants = structuredClone(doc.sessions[f.id]);
  delete doc.sessions[fork.id];
  const withoutGrant = JSON.stringify(doc);
  const reopened = SessionManager.open(fork.path);
  for (const contents of [withoutGrant, "{partial", null]) {
    if (contents === null) rmSync(policyFile);
    else writeFileSync(policyFile, contents);
    const selection = await loadSessionToolSelection(reopened, false, parentTools);
    assert.deepEqual(selection.toolNames, []);
    assert.equal(selection.persistSelection, false);
    assert.deepEqual((await f.handlers.get({ id: fork.id })).toolNames, []);
    setAgentSessionSource(reopened, "local");
    const policy = new SessionToolPolicy(
      reopened,
      selection.toolNames,
      store.getExecution(fork.id),
      store.getMcpExecution(fork.id),
    );
    policy.bind({ getActiveToolNames: () => parentTools });
    for (const tool of parentTools) assert.equal(policy.isAllowed(tool), false);
    if (contents === null) assert.equal(fs.existsSync(policyFile), false);
    else assert.equal(readFileSync(policyFile, "utf8"), contents);
  }
  writeFileSync(policyFile, withoutGrant);
  store.set(fork.id, ["read"]);
  assert.deepEqual((await loadSessionToolSelection(reopened, false)).toolNames, ["read"]);
  assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[f.id], parentGrants);
  assert.deepEqual(readFileSync(f.filename), sourceBytes);
});

test("unreadable permission data rejects creation without rewriting it or retaining the new history", async (t) => {
  const f = fixture(),
    previous = readFileSync(policyFile);
  t.after(() => writeFileSync(policyFile, previous));
  const files = readdirSync(sessions).sort(),
    history = readdirSync(historyRoot).sort();
  for (const invalid of ['{"sessions":', '{"version":2,"sessions":{}}']) {
    writeFileSync(policyFile, invalid);
    await assert.rejects(
      f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }),
      /existing Desktop tool permissions/,
    );
    assert.equal(readFileSync(policyFile, "utf8"), invalid);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readdirSync(sessions).sort(), files);
    assert.deepEqual(readdirSync(historyRoot).sort(), history);
    assert.deepEqual(f.events, []);
  }
});

test("unmarked older forks cannot restore copied grants across folders or from an unknown parent", async () => {
  const f = fixture(),
    parent = SessionManager.open(f.filename);
  parent.appendCustomEntry("pi-desktop-session-tools", { version: 1, toolNames: ["read", "bash"] });
  const bytes = readFileSync(f.filename);
  const other = SessionManager.forkFrom(f.filename, f.destination, sessions);
  assert.deepEqual((await loadSessionToolSelection(other, false)).toolNames, []);
  const same = SessionManager.forkFrom(f.filename, parent.getCwd(), sessions);
  assert.deepEqual((await loadSessionToolSelection(same, false)).toolNames, ["read", "bash"]);
  const orphan = SessionManager.forkFrom(f.filename, parent.getCwd(), sessions),
    store = getDefaultStore();
  await loadSessionToolSelection(same, false, undefined, true);
  renameSync(f.filename, f.filename + ".moved");
  assert.deepEqual((await loadSessionToolSelection(same, false)).toolNames, ["read", "bash"]);
  assert.deepEqual((await loadSessionToolSelection(orphan, false)).toolNames, []);
  assert.equal(store.get(orphan.getSessionId()), undefined);
  assert.deepEqual((await loadSessionToolSelection(orphan, false, undefined, true)).toolNames, []);
  assert.deepEqual(store.get(orphan.getSessionId()), []);
  renameSync(f.filename + ".moved", f.filename);
  assert.deepEqual((await loadSessionToolSelection(orphan, false)).toolNames, []);
  await store.set(orphan.getSessionId(), ["read"]);
  assert.deepEqual((await loadSessionToolSelection(orphan, false)).toolNames, ["read"]);
  const unindexedParent = SessionManager.inMemory(f.destination, undefined, [
    { ...other.getHeader(), parentSession: path.join(root, "unavailable-parent.jsonl") },
    ...other.getEntries(),
  ]);
  assert.deepEqual((await loadSessionToolSelection(unindexedParent, false)).toolNames, []);
  assert.deepEqual(readFileSync(f.filename), bytes);
});

test("a notification failure after publication still returns the completed fork", async (t) => {
  const f = fixture(() => {
    throw new Error("client disconnected");
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const result = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
  assert.equal(SessionManager.open(result.path).getHeader().parentSession, f.filename);
  assert.deepEqual(getDefaultStore().get(result.id), []);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

for (const scenario of [
  "changed root",
  "missing project directory",
  "legacy changed hostname",
  "published file moved",
]) {
  test(`restart resolves a Fork with a ${scenario} and preserves independently owned data`, async (t) => {
    const f = fixture(),
      originalRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
    t.after(() => {
      process.env.PI_CODING_AGENT_SESSION_DIR = originalRoot;
    });
    const id = "interrupted-" + scenario.replaceAll(" ", "-");
    const project = mkdtempSync(path.join(sessions, "recovery-project-"));
    const destination = path.join(project, "2026-11-23_" + id + ".jsonl");
    const worker = path.join(root, id + ".mjs");
    writeFileSync(
      worker,
      `
      import fs from "node:fs";
      import path from "node:path";
      const [module,source,id,destination,scenario] = process.argv.slice(2);
      const {DirectoryForkWorkspace,ExecutionLogStore,getDefaultStore} = await import(module);
      const w = new DirectoryForkWorkspace();
      w.claim(id,source,destination);
      const history = new ExecutionLogStore(id);
      w.trackHistory(history.reserveForkTarget());
      if (scenario !== "legacy changed hostname") {
        await getDefaultStore().publishChatOnlyFork(id, undefined, () => {
          if (scenario === "published file moved") {
            fs.writeFileSync(destination, JSON.stringify({type:"session",version:3,id,cwd:path.dirname(destination),timestamp:new Date().toISOString()})+"\\n");
          }
          process.exit(77);
        },w.directory);
      }
      process.exit(77);
    `,
    );
    const child = forkProcess(worker, [workerModule, f.id, id, destination, scenario], { execArgv: [], silent: true });
    assert.equal((await once(child, "exit"))[0], 77);
    const pending = path.join(desktop, "pending-directory-forks");
    let [name] = readdirSync(pending);
    const claim = path.join(sessions, ".pi-directory-fork-" + id + ".pending");
    if (scenario === "legacy changed hostname") {
      const legacy = name.replace(/^v2-/, "0123456789abcdef-");
      renameSync(path.join(pending, name), path.join(pending, legacy));
      writeFileSync(claim, legacy);
      name = legacy;
      const file = path.join(pending, name, "intent.json"),
        intent = JSON.parse(readFileSync(file));
      delete intent.rootIdentity;
      writeFileSync(file, JSON.stringify(intent));
    }
    let moved;
    if (scenario === "published file moved") {
      moved = path.join(sessions, "renamed-" + id + ".jsonl");
      renameSync(destination, moved);
    }
    if (scenario !== "legacy changed hostname") rmSync(project, { recursive: true });
    if (scenario === "changed root" || moved)
      process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(root, "current-root-"));
    const warn = t.mock.method(console, "warn", () => {});
    await recoverInterruptedDirectoryForks();
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(fs.existsSync(path.join(pending, name)), false);
    assert.equal(fs.existsSync(claim), false);
    assert.equal(fs.existsSync(path.join(historyRoot, id + ".jsonl")), Boolean(moved));
    assert.deepEqual(getDefaultStore().get(id), moved ? [] : undefined);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    if (moved) assert.equal(JSON.parse(readFileSync(moved)).id, id);
  });
}

for (const scenario of [
  "renamed before publish",
  "renamed after publish",
  "published during lock wait",
  "filename reused",
  "occupied file unreadable",
  "new volume offline",
  "permissions changed",
]) {
  test(`Fork recovery preserves the current owner across session roots: ${scenario}`, async (t) => {
    const f = fixture(),
      originalRoot = process.env.PI_CODING_AGENT_SESSION_DIR,
      store = getDefaultStore();
    t.after(() => {
      process.env.PI_CODING_AGENT_SESSION_DIR = originalRoot;
    });
    const directory = mkdtempSync(path.join(root, "relocated-")),
      former = path.join(directory, "former"),
      current = path.join(directory, "current");
    mkdirSync(former);
    process.env.PI_CODING_AGENT_SESSION_DIR = former;
    const sourceFile = path.join(former, path.basename(f.filename));
    fs.copyFileSync(f.filename, sourceFile);
    store.set(f.id, ["read", "edit"]);
    const parentRow = JSON.parse(readFileSync(policyFile)).sessions[f.id];
    await new ExecutionLogStore(f.id).append(execution(f.currentBranch, "retained-parent", { value: "source" }));
    const journal = path.join(historyRoot, f.id + ".jsonl"),
      sourceJournal = readFileSync(journal);
    const published =
      scenario === "renamed after publish" ||
      scenario === "published during lock wait" ||
      scenario === "new volume offline";
    const worker = path.join(directory, "worker.mjs");
    writeFileSync(
      worker,
      `
      import fs from "node:fs";
      const [module,id,cwd,published]=process.argv.slice(2);
      const {forkSessionToDirectory}=await import(module);
      const link=fs.linkSync;
      fs.linkSync=(from,to)=>{if(published==="yes")link(from,to);process.exit(77);};
      await forkSessionToDirectory({id,cwd});
    `,
    );
    const child = forkProcess(worker, [workerModule, f.id, f.destination, published ? "yes" : "no"], {
      execArgv: [],
      silent: true,
    });
    assert.equal((await once(child, "exit"))[0], 77);
    const pending = path.join(desktop, "pending-directory-forks");
    const name = readdirSync(pending).find(
      (n) =>
        fs.existsSync(path.join(pending, n, "intent.json")) &&
        JSON.parse(readFileSync(path.join(pending, n, "intent.json"))).source === f.id,
    );
    assert.ok(name);
    const workspace = path.join(pending, name),
      intent = JSON.parse(readFileSync(path.join(workspace, "intent.json")));
    const marker = ".pi-directory-fork-" + intent.id + ".pending";
    process.env.PI_CODING_AGENT_SESSION_DIR = current;
    let copiedFile = path.join(current, intent.relativeFile),
      expectedSource = sourceFile,
      claim = path.join(former, marker);
    if (scenario.startsWith("renamed")) {
      renameSync(former, current);
      mkdirSync(former);
      writeFileSync(path.join(former, marker), "independent root");
      expectedSource = path.join(current, path.basename(sourceFile));
      claim = path.join(current, marker);
      await recoverInterruptedDirectoryForks();
      assert.equal(readFileSync(path.join(former, marker), "utf8"), "independent root");
    } else {
      mkdirSync(current);
      const destination = path.join(former, intent.relativeFile);
      if (scenario === "published during lock wait") {
        const bytes = readFileSync(destination);
        fs.unlinkSync(destination); // the user is migrating the transcript to the new root
        const entered = createDeferred(),
          run = store.writeLock.prepareThenRun.bind(store.writeLock);
        t.mock.method(store.writeLock, "prepareThenRun", function (...args) {
          entered.resolve();
          return run(...args);
        });
        const unlock = lockfile.lockSync(policyFile, { realpath: false });
        const recovery = recoverInterruptedDirectoryForks();
        try {
          await Promise.race([entered.promise, recovery]);
          copiedFile = path.join(current, "renamed-published.jsonl");
          writeFileSync(copiedFile, bytes);
        } finally {
          unlock();
        }
        await recovery;
      } else if (scenario === "permissions changed") {
        await store.set(intent.id, ["read"]);
        await new ExecutionLogStore(intent.id).append(
          execution(f.currentBranch, "subsequent-writer", { value: "owned history" }),
        );
        await recoverInterruptedDirectoryForks();
      } else if (scenario === "new volume offline") {
        copiedFile = path.join(current, "restored-published.jsonl");
        const bytes = readFileSync(destination);
        // Migrate using a copy (no shared inode) and temporarily dismount its location.
        writeFileSync(copiedFile, Buffer.concat([Buffer.from("\uFEFF\r\n  \n"), bytes]));
        fs.unlinkSync(destination);
        renameSync(current, current + "-offline");
        await recoverInterruptedDirectoryForks();
        assert.equal(fs.existsSync(workspace), true);
        assert.deepEqual(store.get(intent.id), []);
        assert.equal(fs.existsSync(path.join(historyRoot, intent.id + ".jsonl")), true);
        renameSync(current + "-offline", current);
        await recoverInterruptedDirectoryForks();
      } else {
        const independent =
          JSON.stringify({
            type: "session",
            version: 3,
            id: "independent",
            cwd: f.destination,
            timestamp: new Date().toISOString(),
          }) + "\n";
        if (scenario === "occupied file unreadable") {
          writeFileSync(destination, "partial external header");
          await recoverInterruptedDirectoryForks();
          assert.equal(fs.existsSync(workspace), true);
          assert.equal(fs.existsSync(claim), true);
          assert.equal(readFileSync(destination, "utf8"), "partial external header");
        }
        writeFileSync(destination, independent);
        await recoverInterruptedDirectoryForks();
        assert.equal(readFileSync(destination, "utf8"), independent);
      }
    }
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(fs.existsSync(claim), false);
    assert.deepEqual(store.get(intent.id), published ? [] : scenario === "permissions changed" ? ["read"] : undefined);
    assert.equal(
      fs.existsSync(path.join(historyRoot, intent.id + ".jsonl")),
      published || scenario === "permissions changed",
    );
    if (scenario === "permissions changed")
      assert.ok(
        (await new ExecutionLogStore(intent.id).readLatest()).records.some(
          (entry) => entry.executionId === "subsequent-writer",
        ),
      );
    if (published) {
      const header = JSON.parse(readFileSync(copiedFile, "utf8").trimStart().split("\n")[0]);
      assert.equal(header.id, intent.id);
      assert.equal((await new ExecutionLogStore(intent.id).readLatest()).records.length, 1);
    }
    assert.deepEqual(readFileSync(expectedSource), f.bytes);
    assert.deepEqual(readFileSync(journal), sourceJournal);
    assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[f.id], parentRow);
  });
}

for (const point of ["copy", "before", "partial", "after"]) {
  test(`Host restart reconciles an interrupted fork at ${point} without touching the parent`, async () => {
    const f = fixture();
    const store = getDefaultStore();
    store.set(f.id, ["read", "bash"]);
    const parentPolicy = JSON.parse(readFileSync(policyFile)).sessions[f.id];
    await new ExecutionLogStore(f.id).append(execution(f.currentBranch, "original", { value: "source output" }));
    const sourceJournal = path.join(historyRoot, f.id + ".jsonl"),
      journalBytes = readFileSync(sourceJournal);
    const before = readdirSync(sessions).sort(),
      history = readdirSync(historyRoot).sort();
    const worker = path.join(root, "stop-" + point + ".mjs");
    writeFileSync(
      worker,
      `
      import fs from "node:fs";
      const [module, point, id, cwd] = process.argv.slice(2);
      const { ExecutionLogStore, forkSessionToDirectory } = await import(module);
      const stop = () => process.exit(77);
      const link = fs.linkSync;
      fs.linkSync = (...args) => {
        if (point === "partial") throw Object.assign(new Error(), {code: "ENOTSUP"});
        if (point === "after") link(...args);
        stop();
      };
      const copy = ExecutionLogStore.prototype.copyBranch;
      ExecutionLogStore.prototype.copyBranch = async function(...args) {
        await copy.apply(this, args);
        if (point === "copy") stop();
      };
      const write = fs.writeSync;
      fs.writeSync = (...args) => {
        if (point === "partial" && args[1] === "{" && args[2] === 0) stop();
        return write(...args);
      };
      await forkSessionToDirectory({id,cwd});
    `,
    );
    const child = forkProcess(worker, [workerModule, point, f.id, f.destination], { execArgv: [], silent: true });
    assert.equal((await once(child, "exit"))[0], 77);
    const workspaces = path.join(desktop, "pending-directory-forks");
    const [workspace] = readdirSync(workspaces);
    const intent = JSON.parse(readFileSync(path.join(workspaces, workspace, "intent.json")));
    // A different writer may have changed an unrelated policy before restart.
    const policy = JSON.parse(readFileSync(policyFile));
    policy.sessions["independent-update"] = { toolNames: ["edit"], updatedAt: new Date().toISOString() };
    writeFileSync(policyFile, JSON.stringify(policy));
    await recoverInterruptedDirectoryForks();
    assert.deepEqual(readdirSync(workspaces), []);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readFileSync(sourceJournal), journalBytes);
    const finalPolicy = JSON.parse(readFileSync(policyFile));
    assert.deepEqual(finalPolicy.sessions[f.id], parentPolicy);
    assert.deepEqual(finalPolicy.sessions["independent-update"], policy.sessions["independent-update"]);
    if (point === "after") {
      const published = SessionManager.open(path.join(sessions, intent.relativeFile));
      assert.equal(published.getHeader().parentSession, f.filename);
      assert.deepEqual(store.get(intent.id), []);
      assert.equal((await new ExecutionLogStore(intent.id).readLatest()).records.length, 1);
    } else {
      assert.deepEqual(readdirSync(sessions).sort(), before);
      assert.deepEqual(readdirSync(historyRoot).sort(), history);
      assert.equal(store.get(intent.id), undefined);
    }
    const retry = await f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
    assert.notEqual(retry.id, intent.id);
    assert.deepEqual(store.get(retry.id), []);
  });
}

test("copying without hard links releases the permission lock and preserves a concurrent grant on failure", async (t) => {
  const f = fixture(),
    store = getDefaultStore(),
    external = new store.constructor(policyFile);
  const track = DirectoryForkWorkspace.prototype.trackFallback;
  let queued = false,
    independent;
  t.mock.method(DirectoryForkWorkspace.prototype, "trackFallback", function (identity) {
    track.call(this, identity);
    independent = external.set("independent-fallback-grant", ["edit"]);
    queued = independent instanceof Promise;
  });
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("separate volumes"), { code: "EXDEV" });
  });
  const write = fs.writeSync;
  t.mock.method(fs, "writeSync", (...args) => {
    if (args[1] === "{" && args[2] === 0) throw new Error("fixture publication failure");
    return write(...args);
  });
  const originalFiles = readdirSync(sessions).sort();
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), /fixture publication failure/);
  await independent;
  assert.equal(queued, false);
  assert.deepEqual(store.get("independent-fallback-grant"), ["edit"]);
  assert.deepEqual(readdirSync(sessions).sort(), originalFiles);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
});

test("moving the active root during fallback preparation rolls back only the fork's reserved file", async (t) => {
  const f = fixture(),
    previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  t.after(() => {
    process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  });
  const former = mkdtempSync(path.join(root, "live-root-")),
    current = former + "-moved",
    name = path.basename(f.filename);
  fs.copyFileSync(f.filename, path.join(former, name));
  process.env.PI_CODING_AGENT_SESSION_DIR = former;
  const oldPolicy = readFileSync(policyFile),
    oldLogs = readdirSync(historyRoot).sort();
  const track = DirectoryForkWorkspace.prototype.trackFallback;
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("different volume"), { code: "EXDEV" });
  });
  t.mock.method(DirectoryForkWorkspace.prototype, "trackFallback", function (identity) {
    track.call(this, identity);
    renameSync(former, current);
    mkdirSync(former);
    writeFileSync(path.join(former, "unrelated"), "untouched");
    process.env.PI_CODING_AGENT_SESSION_DIR = current;
  });
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code: "CONFLICT" });
  assert.deepEqual(readdirSync(current), [name]);
  assert.deepEqual(readFileSync(path.join(current, name)), f.bytes);
  assert.equal(readFileSync(path.join(former, "unrelated"), "utf8"), "untouched");
  assert.deepEqual(readFileSync(policyFile), oldPolicy);
  assert.deepEqual(readdirSync(historyRoot).sort(), oldLogs);
});

test("foreign history written in place at a fallback destination is neither published as the fork nor removed", async (t) => {
  const f = fixture(),
    store = getDefaultStore(),
    install = store.publishChatOnlyFork.bind(store);
  const originalPolicy = readFileSync(policyFile),
    logs = readdirSync(historyRoot).sort();
  const foreign =
    JSON.stringify({
      type: "session",
      version: 3,
      id: "independent-writer",
      cwd: f.destination,
      timestamp: new Date().toISOString(),
    }) + "\n";
  let destination;
  t.mock.method(fs, "linkSync", (_from, to) => {
    destination = to;
    throw Object.assign(new Error("cross-volume"), { code: "EXDEV" });
  });
  t.mock.method(store, "publishChatOnlyFork", (...args) => {
    if (destination) writeFileSync(destination, foreign);
    return install(...args);
  });
  await assert.rejects(f.handlers.forkToDirectory({ id: f.id, cwd: f.destination }), { code: "CONFLICT" });
  assert.equal(readFileSync(destination, "utf8"), foreign);
  assert.deepEqual(readFileSync(policyFile), originalPolicy);
  assert.deepEqual(readdirSync(historyRoot).sort(), logs);
  assert.deepEqual(readFileSync(f.filename), f.bytes);
  assert.deepEqual(f.events, []);
});

for (const fail of [false, true]) {
  test(`a filesystem without hard links ${fail ? "rolls back a failed publication" : "publishes a complete fork"}`, async (t) => {
    const f = fixture(),
      id = fail ? "fallback-failure" : "fallback-success";
    forceForkId(t, id);
    const history = readdirSync(historyRoot).sort(),
      files = readdirSync(sessions).sort();
    const before = readFileSync(policyFile);
    if (fail) {
      rmSync(policyFile);
      t.after(() => writeFileSync(policyFile, before));
    }
    let destination;
    t.mock.method(fs, "linkSync", (_from, to) => {
      destination = to;
      throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
    });
    const write = fs.writeSync;
    let checked = false;
    t.mock.method(fs, "writeSync", (...args) => {
      if (destination && args[1] === "{" && args[2] === 0) {
        const staged = readFileSync(destination, "utf8");
        assert.ok(staged.startsWith("!"));
        assert.ok(staged.includes("Current branch"));
        assert.deepEqual(JSON.parse(readFileSync(policyFile)).sessions[id].toolNames, []);
        checked = true;
        if (fail) throw new Error("failed to publish completed header");
      }
      return write(...args);
    });
    const pending = f.handlers.forkToDirectory({ id: f.id, cwd: f.destination });
    if (fail) {
      await assert.rejects(pending, /failed to publish completed header/);
      assert.equal(fs.existsSync(policyFile), false);
      assert.deepEqual(readdirSync(sessions).sort(), files);
      assert.deepEqual(readdirSync(historyRoot).sort(), history);
      assert.deepEqual(f.events, []);
    } else {
      const fork = await pending;
      assert.equal(fork.path, destination);
      assert.equal(SessionManager.open(fork.path).getLeafId(), f.currentBranch);
    }
    assert.equal(checked, true);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
  });
}
