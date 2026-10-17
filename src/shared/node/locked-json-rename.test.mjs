import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import timers from "node:timers/promises";
import lockfile from "proper-lockfile";
import { withLockedJsonFile } from "./locked-json-file.ts";

const failure = (code) => Object.assign(new Error(code), { code });

function fixture(t, platform = "win32") {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-json-rename-"));
  const filename = path.join(root, "mcp.json");
  const original = '{"kept":true}';
  fs.writeFileSync(filename, original);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  const state = { releases: 0, options: undefined, delays: [] };
  t.mock.method(lockfile, "lock", async (_filename, options) => {
    state.options = options;
    return async () => state.releases++;
  });
  t.mock.method(Math, "random", () => 0.5);
  t.mock.method(timers, "setTimeout", async (ms) => state.delays.push(ms));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platformDescriptor);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    filename,
    original,
    state,
    assertClean() {
      assert.deepEqual(fs.readdirSync(root), ["mcp.json"]);
      assert.equal(state.releases, 1);
    },
  };
}

test("Windows rename retries preserve the original until one atomic commit without replaying the mutation", async (t) => {
  const f = fixture(t),
    rename = fs.renameSync,
    sources = [];
  let actions = 0,
    checks = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    sources.push(from);
    assert.equal(to, f.filename);
    assert.equal(fs.readFileSync(to, "utf8"), f.original);
    if (sources.length <= 5) throw failure("EPERM");
    rename(from, to);
  });
  syncBuiltinESMExports();
  await withLockedJsonFile(f.filename, async (current, save) => {
    actions++;
    await save({ ...current, saved: true }, () => checks++);
  });
  assert.equal(actions, 1);
  assert.equal(checks, 6);
  assert.equal(new Set(sources).size, 1, "retry only the same completed temporary file");
  assert.deepEqual(f.state.delays, [15, 30, 60, 120, 240]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, "utf8")), { kept: true, saved: true });
  f.assertClean();
});

for (const [platform, code, expectedAttempts] of [
  ["win32", "EPERM", 6],
  ["darwin", "EPERM", 1],
  ["win32", "EACCES", 1],
  ["win32", "ENOENT", 1],
])
  test(`${platform} ${code} rename failure has a bounded retry policy and preserves the destination`, async (t) => {
    const f = fixture(t, platform);
    let attempts = 0;
    t.mock.method(fs, "renameSync", () => {
      attempts++;
      throw failure(code);
    });
    syncBuiltinESMExports();
    await assert.rejects(
      withLockedJsonFile(f.filename, (_current, save) => save({ wrong: true })),
      { code },
    );
    assert.equal(attempts, expectedAttempts);
    assert.equal(f.state.delays.length, expectedAttempts - 1);
    assert.equal(fs.readFileSync(f.filename, "utf8"), f.original);
    f.assertClean();
  });

for (const reason of ["cancelled", "compromised", "changed"])
  test(`a ${reason} rename wait cannot commit and always cleans up`, async (t) => {
    const f = fixture(t),
      controller = new globalThis.AbortController(),
      blocked = new Error(reason);
    let attempts = 0;
    t.mock.method(fs, "renameSync", () => {
      attempts++;
      throw failure("EPERM");
    });
    t.mock.method(timers, "setTimeout", async (_ms, _value, options) => {
      if (reason === "cancelled") {
        assert.equal(options.signal, controller.signal);
        controller.abort(blocked);
        options.signal.throwIfAborted();
      } else if (reason === "compromised") f.state.options.onCompromised(blocked);
      else fs.writeFileSync(f.filename, '{"external":true}');
    });
    syncBuiltinESMExports();
    await assert.rejects(
      withLockedJsonFile(
        f.filename,
        (_current, save) =>
          save({ wrong: true }, () => {
            if (fs.readFileSync(f.filename, "utf8") !== f.original) throw blocked;
          }),
        controller.signal,
      ),
      (error) => error === blocked,
    );
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(f.filename, "utf8"), reason === "changed" ? '{"external":true}' : f.original);
    f.assertClean();
  });

test("beforeCommit failures are never mistaken for rename failures", async (t) => {
  const f = fixture(t);
  let checks = 0;
  await assert.rejects(
    withLockedJsonFile(f.filename, (_current, save) =>
      save({ wrong: true }, () => {
        checks++;
        throw failure("EPERM");
      }),
    ),
    { code: "EPERM" },
  );
  assert.equal(checks, 1);
  assert.equal(f.state.delays.length, 0);
  assert.equal(fs.readFileSync(f.filename, "utf8"), f.original);
  f.assertClean();
});

test("cancellation after a successful rename cannot report the committed write as cancelled", async (t) => {
  const f = fixture(t),
    rename = fs.renameSync,
    controller = new globalThis.AbortController();
  let attempts = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (++attempts === 1) throw failure("EPERM");
    rename(from, to);
    controller.abort();
  });
  syncBuiltinESMExports();
  await withLockedJsonFile(f.filename, (_current, save) => save({ committed: true }), controller.signal);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, "utf8")), { committed: true });
  assert.equal(attempts, 2);
  f.assertClean();
});
