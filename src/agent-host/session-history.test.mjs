import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
const {
  buildSessionHistoryPage,
  decodeHistoryCursor,
  readSessionEntryContent,
  readSessionEntryDetails,
  StaleHistoryCursorError,
} = await importTestBundle("src/agent-host/session-history", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "session-history.ts")],
});

const timestamp = "2026-08-06T00:00:00.000Z";

function chain(definitions) {
  let parentId = null;
  return definitions.map((definition, index) => {
    const entry = { id: `entry-${index}`, parentId, timestamp, ...definition };
    parentId = entry.id;
    return entry;
  });
}

function user(content) {
  return { type: "message", message: { role: "user", content } };
}

function assistant(content) {
  return {
    type: "message",
    message: { role: "assistant", content, provider: "provider", model: "model", timestamp: 1 },
  };
}

function toolResult(toolCallId, text) {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId, content: [{ type: "text", text }], timestamp: 2 },
  };
}

test("history pages preserve complete turns and reconstruct the full display history", () => {
  const entries = chain([
    user("first"),
    assistant([{ type: "text", text: "first answer" }]),
    user("second"),
    assistant([{ type: "toolCall", toolCallId: "call", toolName: "read", input: { path: "file" } }]),
    toolResult("call", "tool output"),
    assistant([{ type: "text", text: "second answer" }]),
    user("third"),
    assistant([{ type: "text", text: "third answer" }]),
  ]);
  const revision = "revision-one";
  const newest = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes: 128 * 1024 },
    historyRevision: revision,
  });
  assert.deepEqual(
    newest.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(newest.truncatedBefore, true);

  const middleCursor = decodeHistoryCursor(newest.previousCursor);
  const middle = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes: 128 * 1024 },
    historyRevision: revision,
    cursor: middleCursor,
  });
  assert.deepEqual(
    middle.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );

  const oldest = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes: 128 * 1024 },
    historyRevision: revision,
    cursor: decodeHistoryCursor(middle.previousCursor),
  });
  const reconstructedMessages = [...oldest.messages, ...middle.messages, ...newest.messages];
  const reconstructedEntryIds = [...oldest.entryIds, ...middle.entryIds, ...newest.entryIds];
  const full = buildSessionHistoryPage({ entries, historyRevision: revision });
  assert.deepEqual(reconstructedMessages, full.messages);
  assert.deepEqual(reconstructedEntryIds, full.entryIds);
});

test("oversized text blocks are deferred within the byte budget and can be read exactly", () => {
  const oversized = "large-output-".repeat(30_000);
  const entries = chain([
    user("inspect"),
    assistant([{ type: "toolCall", toolCallId: "call", toolName: "inspect", input: {} }]),
    toolResult("call", oversized),
    assistant([{ type: "text", text: "done" }]),
  ]);
  const maxBytes = 96 * 1024;
  const page = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 20, maxBytes },
    historyRevision: "revision-two",
  });
  const result = page.messages.find((message) => message.role === "toolResult");
  const block = result.content[0];
  assert.equal(block.type, "text");
  assert.equal(block.deferredContent.entryId, "entry-2");
  assert.equal(block.deferredContent.originalBytes, Buffer.byteLength(oversized));
  assert.equal(Buffer.byteLength(JSON.stringify(page)) <= maxBytes, true);
  assert.deepEqual(readSessionEntryContent(entries, "entry-2", 0), { type: "text", text: oversized });
});

test("oversized inline images are deferred and restored as the original block", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "a".repeat(180 * 1024) },
  };
  const entries = chain([user("image"), assistant([image, { type: "text", text: "caption" }])]);
  const page = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 },
    historyRevision: "image-revision",
  });
  const assistantMessage = page.messages[1];
  assert.equal(assistantMessage.content[0].type, "image");
  assert.equal(assistantMessage.content[0].deferredContent.contentType, "image");
  assert.equal(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024, true);
  assert.deepEqual(readSessionEntryContent(entries, "entry-1", 0), image);
});

test("oversized thinking and tool inputs cannot empty the newest page", () => {
  const thinking = { type: "thinking", thinking: "reasoning-".repeat(30_000) };
  const toolCall = {
    type: "toolCall",
    toolCallId: "large-call",
    toolName: "write",
    input: { content: "generated-code-".repeat(30_000) },
  };
  const entries = chain([user("generate"), assistant([thinking, toolCall]), toolResult("large-call", "done")]);
  const maxBytes = 96 * 1024;
  const page = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes },
    historyRevision: "large-process-revision",
  });
  assert.equal(page.messages.length, 3);
  assert.equal(page.messages[1].content[0].deferredContent.contentType, "thinking");
  assert.equal(page.messages[1].content[1].deferredContent.contentType, "toolCall");
  assert.equal(Buffer.byteLength(JSON.stringify(page)) <= maxBytes, true);
  assert.deepEqual(readSessionEntryContent(entries, "entry-1", 0), thinking);
  assert.deepEqual(readSessionEntryContent(entries, "entry-1", 1), toolCall);
});

for (const latestBytes of [16, 28 * 1024]) {
  test(`oversized turns paginate in order with a ${latestBytes}-byte latest answer`, () => {
    const entries = oversizedTurnEntries(latestBytes);
    const originalEntries = structuredClone(entries);
    const historyRevision = "oversized-turn-revision";
    const maxBytes = 32 * 1024;
    const full = buildSessionHistoryPage({ entries, historyRevision });
    const messages = [];
    const entryIds = [];
    const cursors = new Set();
    let cursor;
    let deferredBlocks = 0;
    let pageCount = 0;
    do {
      const page = buildSessionHistoryPage({
        entries,
        historyRevision,
        historyWindow: { maxBytes },
        ...(cursor ? { cursor: decodeHistoryCursor(cursor) } : {}),
      });
      assert.ok(page.loadedMessages > 0, "every page must make progress through the oversized turn");
      assert.equal(page.loadedMessages, page.messages.length);
      assert.equal(page.totalMessages, full.messages.length);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      assert.equal(page.truncatedBefore, Boolean(page.previousCursor));
      if (pageCount === 0) {
        assert.deepEqual(page.entryIds.slice(-2), full.entryIds.slice(-2));
        if (latestBytes === 16) assert.ok(page.loadedMessages > 2, "use the remaining budget for the turn's tail");
        else assert.equal(page.loadedMessages, 2, "leave the oversized turn for a fresh page when no message fits");
      }
      const restored = page.messages.map((message) => ({
        ...message,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) => {
                if (!block.deferredContent) return block;
                deferredBlocks += 1;
                const { entryId, blockIndex } = block.deferredContent;
                return readSessionEntryContent(entries, entryId, blockIndex);
              }),
      }));
      messages.unshift(...restored);
      entryIds.unshift(...page.entryIds);
      cursor = page.previousCursor;
      if (cursor) {
        assert.equal(decodeHistoryCursor(cursor).beforeEntryId, page.entryIds[0]);
        assert.equal(cursors.has(cursor), false, "history cursors must advance");
        cursors.add(cursor);
      }
      pageCount += 1;
    } while (cursor);
    assert.ok(pageCount > 2);
    assert.equal(deferredBlocks, 0, "a split turn uses standard previews, which leave 8 KiB blocks intact");
    assert.deepEqual(entryIds, full.entryIds);
    assert.deepEqual(messages, full.messages);
    assert.deepEqual(entries, originalEntries, "paging must not mutate stored messages");
  });
}

function walkHistoryPages(entries, maxBytes) {
  const historyRevision = "walk-revision";
  const full = buildSessionHistoryPage({ entries, historyRevision });
  const pages = [];
  const entryIds = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = buildSessionHistoryPage({
      entries,
      historyRevision,
      historyWindow: { maxBytes },
      ...(cursor ? { cursor: decodeHistoryCursor(cursor) } : {}),
    });
    assert.ok(page.loadedMessages > 0, "every page must make progress");
    assert.equal(page.truncatedBefore, Boolean(page.previousCursor));
    pages.push(page);
    entryIds.unshift(...page.entryIds);
    cursor = page.previousCursor;
    if (cursor) {
      assert.equal(cursors.has(cursor), false, "history cursors must advance");
      cursors.add(cursor);
    }
  } while (cursor);
  assert.deepEqual(entryIds, full.entryIds);
  return { full, pages };
}

function oversizedTurnEntries(latestBytes) {
  return chain([
    user("older turn"),
    assistant([{ type: "text", text: "older answer" }]),
    user("long task"),
    ...Array.from({ length: 24 }, (_, index) => [
      assistant([
        { type: "text", text: "a".repeat(8192) },
        { type: "toolCall", toolCallId: `call-${index}`, toolName: "read", input: { path: `file-${index}` } },
      ]),
      toolResult(`call-${index}`, "r".repeat(4096)),
    ]).flat(),
    user("latest turn"),
    assistant([{ type: "text", text: "z".repeat(latestBytes) }]),
  ]);
}

for (const maxBytes of [32 * 1024, 64 * 1024, 96 * 1024]) {
  test(`a turn split across ${maxBytes / 1024} KiB pages keeps standard previews, including its head`, () => {
    const entries = oversizedTurnEntries(16);
    const { full, pages } = walkHistoryPages(entries, maxBytes);
    assert.ok(pages.length > 2);
    for (const page of pages) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      const firstIndex = full.entryIds.indexOf(page.entryIds[0]);
      // 8 KiB blocks stay below the standard threshold; only a complete turn may use aggressive previews.
      assert.deepEqual(page.messages, full.messages.slice(firstIndex, firstIndex + page.messages.length));
    }
  });
}

test("oversized details are omitted with a loadable reference", () => {
  const details = { diff: "d".repeat(200 * 1024) };
  const customDetails = { report: "c".repeat(200 * 1024) };
  const entries = chain([
    user("edit"),
    assistant([{ type: "toolCall", toolCallId: "call", toolName: "edit", input: { path: "file" } }]),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "edit",
        content: [{ type: "text", text: "edited" }],
        details,
        timestamp: 2,
      },
    },
    { type: "custom_message", customType: "report", content: "report", display: true, details: customDetails },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "small",
        content: [{ type: "text", text: "small" }],
        details: { diff: "small" },
        timestamp: 3,
      },
    },
  ]);
  const originalEntries = structuredClone(entries);
  const page = buildSessionHistoryPage({ entries, historyRevision: "details", historyWindow: {} });
  const [, , result, custom, small] = page.messages;
  assert.equal("details" in result, false);
  assert.deepEqual(result.deferredDetails, {
    entryId: "entry-2",
    originalBytes: Buffer.byteLength(JSON.stringify(details)),
    contentType: "details",
  });
  assert.deepEqual(result.content, [{ type: "text", text: "edited" }]);
  assert.equal("details" in custom, false);
  assert.equal(custom.deferredDetails.entryId, "entry-3");
  assert.deepEqual(small.details, { diff: "small" });
  assert.equal("deferredDetails" in small, false);
  assert.deepEqual(readSessionEntryDetails(entries, "entry-2"), { details });
  assert.deepEqual(readSessionEntryDetails(entries, "entry-3"), { details: customDetails });
  assert.equal(readSessionEntryDetails(entries, "entry-1"), null);
  assert.equal(readSessionEntryDetails(entries, "missing"), null);
  assert.deepEqual(entries, originalEntries, "paging must not mutate stored messages");
});

test("a single message over budget after standard previews still advances pagination", async (t) => {
  const maxBytes = 32 * 1024;
  await t.test("many small blocks receive minimal previews", () => {
    const blocks = Array.from({ length: 40 }, (_, index) => ({ type: "text", text: String(index).repeat(3000) }));
    const entries = chain([
      user("first"),
      assistant([{ type: "text", text: "first answer" }]),
      user("dump"),
      assistant(blocks),
    ]);
    const { full, pages } = walkHistoryPages(entries, maxBytes);
    const [newest] = pages;
    assert.deepEqual(newest.entryIds, ["entry-3"]);
    assert.ok(Buffer.byteLength(JSON.stringify(newest)) <= maxBytes);
    newest.messages[0].content.forEach((block, blockIndex) => {
      assert.equal(block.deferredContent?.blockIndex, blockIndex);
      assert.deepEqual(readSessionEntryContent(entries, "entry-3", blockIndex), full.messages[3].content[blockIndex]);
    });
  });
  await t.test("oversized details are deferred for the message alone", () => {
    const entries = chain([
      user("first"),
      assistant([{ type: "toolCall", toolCallId: "call", toolName: "mcp", input: {} }]),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call",
          content: [{ type: "text", text: "ok" }],
          details: { structuredContent: Array.from({ length: 400 }, (_, index) => ({ index, text: "s".repeat(80) })) },
          timestamp: 2,
        },
      },
    ]);
    const { pages } = walkHistoryPages(entries, maxBytes);
    assert.deepEqual(pages[0].entryIds, ["entry-2"]);
    assert.equal(pages[0].messages[0].deferredDetails.contentType, "details");
    assert.ok(Buffer.byteLength(JSON.stringify(pages[0])) <= maxBytes);
  });
  await t.test("non-deferrable metadata is returned over budget instead of ending history", () => {
    const blocks = Array.from({ length: 3000 }, () => ({ type: "text", text: "x" }));
    const entries = chain([
      user("first"),
      assistant([{ type: "text", text: "first answer" }]),
      user("dump"),
      assistant(blocks),
    ]);
    const { full, pages } = walkHistoryPages(entries, maxBytes);
    assert.deepEqual(pages[0].entryIds, ["entry-3"]);
    assert.ok(Buffer.byteLength(JSON.stringify(pages[0])) > maxBytes);
    assert.deepEqual(pages[0].messages[0], full.messages[3]);
  });
});

test("channel markers cross page boundaries and settings match the active branch", () => {
  const entries = chain([
    user("old"),
    assistant([{ type: "text", text: "old answer" }]),
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "model_change", provider: "next-provider", modelId: "next-model" },
    {
      type: "custom",
      customType: "pi-desktop-channel-source",
      data: { channel: "telegram", runId: "external-turn" },
    },
    user("external"),
    assistant([{ type: "text", text: "reply" }]),
  ]);
  const page = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 },
    historyRevision: "revision-three",
  });
  assert.equal(page.messages[0].role, "user");
  assert.equal(page.messages[0].channelSource, "telegram");
  assert.equal(page.thinkingLevel, "high");
  // A later assistant message is authoritative, matching pi's context settings semantics.
  assert.deepEqual(page.model, { provider: "provider", modelId: "model" });
});

test("compaction and branch summaries survive page boundaries with aligned entry ids", () => {
  const entries = chain([
    user("old"),
    assistant([{ type: "text", text: "old answer" }]),
    {
      type: "compaction",
      summary: "compressed history",
      firstKeptEntryId: "entry-0",
      tokensBefore: 100,
    },
    {
      type: "branch_summary",
      summary: "alternate branch",
      fromId: "entry-1",
    },
    user("new"),
    assistant([{ type: "text", text: "new answer" }]),
  ]);
  const revision = "summary-revision";
  const full = buildSessionHistoryPage({ entries, historyRevision: revision });
  const pages = [];
  let cursor;
  do {
    const page = buildSessionHistoryPage({
      entries,
      historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 },
      historyRevision: revision,
      ...(cursor ? { cursor: decodeHistoryCursor(cursor) } : {}),
    });
    pages.unshift(page);
    cursor = page.previousCursor;
  } while (cursor);
  assert.deepEqual(
    pages.flatMap((page) => page.messages),
    full.messages,
  );
  assert.deepEqual(
    pages.flatMap((page) => page.entryIds),
    full.entryIds,
  );
  assert.equal(
    full.messages.some((message) => message.role === "custom" && message.customType === "compaction"),
    true,
  );
  assert.equal(
    full.messages.some((message) => message.role === "user" && String(message.content).includes("another branch")),
    true,
  );
});

test("stale or malformed cursors are rejected", () => {
  const entries = chain([user("one"), assistant([{ type: "text", text: "answer" }]), user("two")]);
  const page = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1 },
    historyRevision: "current-revision",
  });
  const cursor = decodeHistoryCursor(page.previousCursor);
  assert.throws(
    () =>
      buildSessionHistoryPage({
        entries,
        historyWindow: { maxTurns: 1 },
        historyRevision: "replacement-revision",
        cursor,
      }),
    StaleHistoryCursorError,
  );
  assert.throws(() => decodeHistoryCursor("not-a-cursor"), /Invalid session history cursor/);
});

test("append-only growth keeps cursors valid while truncation invalidates them", () => {
  const entries = chain([
    user("one"),
    assistant([{ type: "text", text: "answer one" }]),
    user("two"),
    assistant([{ type: "text", text: "answer two" }]),
  ]);
  const revision = "append-stable-revision";
  const newest = buildSessionHistoryPage({
    entries,
    historyWindow: { maxTurns: 1 },
    historyRevision: revision,
  });
  const cursor = decodeHistoryCursor(newest.previousCursor);
  const appended = chain([
    user("one"),
    assistant([{ type: "text", text: "answer one" }]),
    user("two"),
    assistant([{ type: "text", text: "answer two" }]),
    user("three"),
  ]);
  const older = buildSessionHistoryPage({
    entries: appended,
    historyWindow: { maxTurns: 1 },
    historyRevision: revision,
    cursor,
  });
  assert.equal(older.messages[0].content, "one");
  assert.throws(
    () =>
      buildSessionHistoryPage({
        entries: entries.slice(0, 2),
        historyWindow: { maxTurns: 1 },
        historyRevision: revision,
        cursor,
      }),
    StaleHistoryCursorError,
  );
});
