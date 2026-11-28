import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { importTestBundle } from "#test-bundle";

const { ExtensionDialogs, readBashOutputPage, searchSessionMessages, cacheSessionPath, buildSessionHistoryPage } =
  await importTestBundle("ux-history-and-dialogs", {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents:
        'export {ExtensionDialogs} from "./extension-dialogs"; export {readBashOutputPage} from "./bash-output-preview"; export {searchSessionMessages} from "./session-body-search"; export {cacheSessionPath} from "./session-reader"; export {buildSessionHistoryPage} from "./session-history";',
    },
  });

test("dialog cancellation, timeout, approval and late replies each settle once", async () => {
  const events = [],
    dialogs = new ExtensionDialogs((e) => events.push(e));
  const ask = (opts = {}) =>
    dialogs.ask(
      { method: "confirm", title: "Allow", message: "Approve?" },
      false,
      (r) => r.confirmed === true,
      opts.timeout,
      opts.signal,
    );
  const active = ask({ timeout: 35000 }),
    { id, expiresAt } = dialogs.snapshot()[0];
  assert.equal(dialogs.snapshot()[0].expiresAt, expiresAt);
  dialogs.cancelAll();
  dialogs.answer({ id, confirmed: true });
  assert.equal(await active, false);
  const approved = ask(),
    second = dialogs.snapshot()[0].id;
  dialogs.answer({ id: second, confirmed: true });
  dialogs.cancelAll();
  assert.equal(await approved, true);
  const timeout = ask({ timeout: 5 });
  assert.equal(await timeout, false);
  const c = new globalThis.AbortController(),
    pending = ask({ signal: c.signal });
  c.abort();
  assert.equal(await pending, false);
  assert.deepEqual(dialogs.snapshot(), []);
  assert.equal(events.filter((e) => e.method === "dialog_closed").length, 4);
});

test("CLI output pages preserve multibyte boundaries and reject missing files, hard links and symlinks", async (t) => {
  const name = () => path.join(tmpdir(), "pi-bash-" + randomBytes(8).toString("hex") + ".log");
  const file = name(),
    link = name(),
    text = "a".repeat(65535) + "青岚✓".repeat(27000);
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rm(link, { force: true });
  });
  assert.equal((await readBashOutputPage(file, 0)).status, "missing");
  await fs.writeFile(file, text);
  if (process.platform === "darwin") {
    const previous = process.env.TMPDIR;
    try {
      delete process.env.TMPDIR;
      assert.equal((await readBashOutputPage(file, 0)).status, "ready");
    } finally {
      if (previous !== undefined) process.env.TMPDIR = previous;
    }
  }
  let offset = 0,
    combined = "";
  do {
    const chunk = await readBashOutputPage(file, offset);
    assert.equal(chunk.status, "ready");
    combined += chunk.text;
    offset = chunk.nextOffset;
  } while (offset !== undefined);
  assert.equal(combined, text);
  assert.equal((await readBashOutputPage(path.join(tmpdir(), "another-name.log"), 0)).status, "untrusted");
  if (process.platform !== "win32") {
    await fs.symlink(file, link);
    assert.equal((await readBashOutputPage(link, 0)).status, "untrusted");
    await fs.unlink(link);
    await fs.link(file, link);
    assert.equal((await readBashOutputPage(link, 0)).status, "untrusted");
  }
});

test("body search covers the visible branch and messages before compaction, invalidating edited files", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pi-visible-search-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl"),
    id = randomUUID(),
    stamp = new Date().toISOString();
  const message = (id, parentId, role, content) => ({
    type: "message",
    id,
    parentId,
    timestamp: stamp,
    message: { role, content, timestamp: 1 },
  });
  const entries = [
    { type: "session", version: 3, id, cwd: dir, timestamp: stamp },
    message("user", null, "user", "Find the invoice"),
    message("abandoned", "user", "assistant", [{ type: "text", text: "BRANCH_HIDDEN" }]),
    message("done", "user", "assistant", [
      { type: "thinking", thinking: "THINK_HIDDEN" },
      { type: "text", text: "Result QL-F99DE6" },
    ]),
    message("sys", "done", "system", "SYSTEM_HIDDEN"),
    message("tool", "sys", "toolResult", [{ type: "text", text: "TOOL_HIDDEN" }]),
    message(
      "skill",
      "tool",
      "user",
      '<skill name="qa" location="/private/path">\nSKILL_HIDDEN\n</skill>\n\nCheck the result',
    ),
    {
      type: "compaction",
      id: "compact",
      parentId: "skill",
      timestamp: stamp,
      summary: "Summary",
      firstKeptEntryId: "skill",
      tokensBefore: 2048,
    },
  ];
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  cacheSessionPath(id, file);
  const search = (query) => searchSessionMessages({ ids: [id], query });
  assert.match((await search("ql-f99de6")).matches[0].snippet, /QL-F99DE6/);
  assert.equal((await search("hidden")).matches.length, 0);
  await fs.appendFile(file, JSON.stringify(message("new", "compact", "user", "follow-up code QL-SECOND")) + "\n");
  assert.equal((await search("QL-SECOND")).matches[0].id, id);
});

test("reopened history hides only an omitted error superseded by another assistant in the same turn", () => {
  const entry = (id, parentId, message) => ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message,
  });
  const error = (detail) => ({
    role: "assistant",
    stopReason: "error",
    errorMessage: detail,
    content: [],
    provider: "qa",
    model: "fast",
    timestamp: 12,
  });
  const prompt = { role: "user", content: "question", timestamp: 1 };
  const path = [
    entry("u1", null, prompt),
    entry("historic", "u1", error("previous terminal failure")),
    entry("u2", "historic", prompt),
    entry("retry", "u2", error("temporary")),
    { type: "context_edit", id: "omit", parentId: "retry", targetId: "retry", replacement: null },
    entry("final", "omit", error("terminal 503")),
  ];
  const result = buildSessionHistoryPage({ entries: path, historyRevision: "test" });
  assert.deepEqual(
    result.messages.filter((m) => m.role === "assistant").map((m) => m.errorMessage),
    ["previous terminal failure", "terminal 503"],
  );
});
