import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
const { ExecutionLogStore } = await importTestBundle("execution-log-store", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "execution-log-store.ts")],
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-execution-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const record = (id, status = "requested", anchor = "branch-a") => ({
  executionId: id,
  runId: "run-a",
  toolCallId: id,
  rootToolCallId: id,
  anchorEntryId: anchor,
  source: "local",
  toolName: "process_read",
  status,
  requestedAt: 1,
});

test("execution payloads preserve original data with durable verified large content references", async (t) => {
  const root = fixture(t),
    store = new ExecutionLogStore("fixture", root);
  const value = {
    content: [{ type: "text", text: "RAW_MARKER_" + "x".repeat(65536) }],
    structuredContent: { output: "output" },
  };
  const payload = await store.payload(value);
  assert.ok(payload.ref);
  assert.equal(payload.complete, true);
  await store.append({ ...record("one", "succeeded"), result: payload });
  const reopened = new ExecutionLogStore("fixture", root);
  const page = await reopened.readLatest({ includeContent: true, maxContentBytes: 131072 });
  assert.deepEqual(page.records[0].result.value, value);
  await assert.rejects(reopened.readContent("../outside", 1000));
  const content = path.join(root, "tool-executions/fixture/content", payload.ref.hash + ".json");
  writeFileSync(content, "{}");
  await assert.rejects(reopened.readContent(payload.ref.hash, 131072), /integrity/);
});

test("missing terminal states recover as interrupted while successful child calls remain successful", async (t) => {
  const root = fixture(t),
    store = new ExecutionLogStore("fixture", root);
  await store.append(record("parent", "running"));
  await store.append({ ...record("child", "succeeded"), parentToolCallId: "parent", rootToolCallId: "parent" });
  const readonlyBefore = readFileSync(path.join(root, "tool-executions/fixture.jsonl"));
  await new ExecutionLogStore("fixture", root).readLatest();
  assert.deepEqual(readFileSync(path.join(root, "tool-executions/fixture.jsonl")), readonlyBefore);
  const recovery = new ExecutionLogStore("fixture", root);
  const repaired = await recovery.recoverInterrupted();
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].outcomeUnknown, true);
  const states = new Map((await recovery.readLatest()).records.map((entry) => [entry.executionId, entry.status]));
  assert.equal(states.get("parent"), "interrupted");
  assert.equal(states.get("child"), "succeeded");
  assert.equal((await recovery.recoverInterrupted()).length, 0);
});

test("fork copies only visible branch records and materializes its content independently", async (t) => {
  const root = fixture(t),
    store = new ExecutionLogStore("source", root);
  await store.append({ ...record("visible", "succeeded"), result: await store.payload({ text: "x".repeat(65536) }) });
  await store.append(record("other", "failed", "branch-b"));
  await store.copyBranch("fork", new Set(["branch-a"]));
  rmSync(path.join(root, "tool-executions/source"), { recursive: true, force: true });
  const page = await new ExecutionLogStore("fork", root).readLatest({ includeContent: true });
  assert.deepEqual(
    page.records.map((entry) => entry.executionId),
    ["visible"],
  );
  assert.equal(page.records[0].result.value.text.length, 65536);
  assert.equal(page.records[0].sessionId, "fork");
});

test("damaged tail is reported read-only and explicit recovery preserves its bytes before restoring append boundaries", async (t) => {
  const root = fixture(t),
    store = new ExecutionLogStore("fixture", root);
  await store.append(record("one"));
  const filename = path.join(root, "tool-executions/fixture.jsonl");
  appendFileSync(filename, '{"unfinished":');
  const before = readFileSync(filename);
  const page = await new ExecutionLogStore("fixture", root).readLatest();
  assert.equal(page.truncatedTail, true);
  assert.equal(page.complete, false);
  assert.deepEqual(readFileSync(filename), before);
  const reopened = new ExecutionLogStore("fixture", root);
  const recovery = await reopened.recoverInterrupted();
  assert.equal(recovery.length, 1);
  assert.equal((await reopened.readLatest()).truncatedTail, false);
  assert.equal((await reopened.readLatest()).records[0].status, "interrupted");
  const backups = path.join(root, "tool-executions/fixture/recovery");
  assert.equal(readFileSync(path.join(backups, readdirSync(backups)[0]), "utf8"), '{"unfinished":');
});

test("execution export keeps raw inline and referenced data and removal deletes both ownership paths", async (t) => {
  const root = fixture(t),
    store = new ExecutionLogStore("fixture", root);
  await store.append({
    ...record("inline", "succeeded"),
    arguments: await store.payload({ text: "original arguments" }),
  });
  const result = await store.payload({ output: "export original".repeat(8192) });
  await store.append({ ...record("large", "succeeded"), result });
  const bundle = await store.exportBundle();
  assert.equal(bundle.content[result.ref.hash].output, "export original".repeat(8192));
  assert.equal(
    bundle.records.find((entry) => entry.executionId === "inline").arguments.value.text,
    "original arguments",
  );
  const projected = await store.readLatest({ includeContent: true, maxContentBytes: 1 }, undefined, { project: true });
  assert.equal(projected.records.find((entry) => entry.executionId === "inline").arguments.contentOmitted, true);
  assert.equal(
    (await store.exportBundle()).records.find((entry) => entry.executionId === "inline").arguments.value.text,
    "original arguments",
  );
  await store.remove();
  assert.equal(existsSync(path.join(root, "tool-executions/fixture.jsonl")), false);
  assert.equal(existsSync(path.join(root, "tool-executions/fixture")), false);
});

test("content chunks reconstruct original Unicode JSON with stable byte offsets and verified integrity", async (t) => {
  const store = new ExecutionLogStore("fixture", fixture(t));
  const original = { text: "原始结果😀".repeat(2000) },
    payload = await store.payload(original);
  let offset = 0,
    text = "";
  do {
    const chunk = await store.readContentChunk(payload.ref.hash, offset, 1003);
    text += chunk.text;
    offset = chunk.nextOffset;
  } while (offset !== undefined);
  assert.deepEqual(JSON.parse(text), original);
  await assert.rejects(store.readContentChunk(payload.ref.hash, -1), /Invalid/);
});
