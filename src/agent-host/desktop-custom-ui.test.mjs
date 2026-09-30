import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopCustomUiBridge } from "./desktop-custom-ui.ts";
import { createDesktopCustomTheme } from "./desktop-custom-theme.ts";
import {
  bracketedPaste,
  customUiWidth,
  isCustomUiAction,
  normalizeViewport,
  MAX_CUSTOM_UI_INPUT,
} from "../shared/desktop-custom-ui.ts";

function fixture() {
  const frames = [],
    errors = [];
  const bridge = new DesktopCustomUiBridge({
    frame: (value) => frames.push(value),
    error: (id, error) => errors.push({ id, error }),
  });
  return { bridge, frames, errors, id: () => frames.find((frame) => !frame.closed)?.id };
}
const settleFactory = () => delay(0);

for (const [name, options, viewport, expected] of [
  ["default", undefined, { columns: 118, rows: 30 }, 92],
  ["Bro percentage", { overlayOptions: { width: "78%", minWidth: 48 } }, { columns: 100, rows: 30 }, 78],
  ["narrow window beats minWidth", { overlayOptions: { width: "78%", minWidth: 48 } }, { columns: 30, rows: 30 }, 30],
  ["large numeric width is clamped", { overlayOptions: { width: 9000 } }, { columns: 100, rows: 30 }, 100],
  ["function options", { overlayOptions: (columns) => ({ width: columns - 10 }) }, { columns: 100, rows: 30 }, 90],
  ["invalid width falls back", { overlayOptions: { width: NaN } }, { columns: 118, rows: 30 }, 92],
])
  test(`layout: ${name}`, () => assert.equal(customUiWidth(options, viewport), expected));

test("insertion ownership is aborted on panel close and replaced on reopen", async () => {
  const f = fixture();
  const first = f.bridge.open(() => ({ render: () => ["one"] }));
  const owner = f.bridge.getOwner();
  assert.ok(owner);
  assert.equal(owner.signal.aborted, false);
  f.bridge.closeAll();
  await first;
  assert.equal(owner.signal.aborted, true);
  assert.equal(f.bridge.getOwner(), undefined);
  const next = f.bridge.open(() => ({ render: () => ["two"] }));
  assert.notEqual(f.bridge.getOwner().id, owner.id);
  f.bridge.closeAll();
  await next;
});

test("viewport is bounded", () =>
  assert.deepEqual(normalizeViewport({ columns: 1000, rows: 1 }), { columns: 240, rows: 8 }));

test("control actions reject invalid payloads", () => {
  for (const value of [
    null,
    [],
    {},
    { kind: "resize", columns: 0, rows: 10 },
    { kind: "resize", columns: NaN, rows: 10 },
    { kind: "resize", columns: 10.5, rows: 10 },
    { kind: "paste", text: 1 },
    { kind: "paste", text: "x".repeat(MAX_CUSTOM_UI_INPUT + 1) },
  ])
    assert.equal(isCustomUiAction(value), false);
  for (const value of [{ kind: "close" }, { kind: "resize", columns: 80, rows: 24 }, { kind: "paste", text: "hello" }])
    assert.equal(isCustomUiAction(value), true);
});

test("paste is one bracketed input, newline-normalized and stripped of terminal commands", () => {
  const result = bracketedPaste("A\r\nB\rC\tD\x1b[201~\x03E");
  assert.equal(result, "\x1b[200~A\nB\nC\tD[201~E\x1b[201~");
  assert.equal(result.split("\x1b").length - 1, 2);
  assert.throws(() => bracketedPaste("x".repeat(MAX_CUSTOM_UI_INPUT + 1)));
});

test("theme provides every Bro-consumed style without a real terminal", () => {
  const theme = createDesktopCustomTheme();
  for (const method of ["bold", "italic", "underline", "inverse", "strikethrough"])
    assert.match(theme[method]("text"), /text/);
  assert.match(theme.fg("accent", theme.bold("Bro")), /Bro/);
  assert.match(theme.fg("future-color", "text"), /text/);
  assert.equal(theme.getColorMode(), "256color");
  assert.equal(theme.fg("accent", "a\x1b[39mb"), "\x1b[36ma\x1b[36mb\x1b[39m");
});

test("factory receives theme and a virtual viewport; component focuses and resolves", async () => {
  const f = fixture();
  let done, env;
  let disposed = 0;
  const component = { focused: false, render: (width) => [`width=${width}`], dispose: () => disposed++ };
  const result = f.bridge.open((tui, theme, keys, finish) => {
    env = tui;
    done = finish;
    assert.equal(keys, undefined);
    assert.equal(typeof theme.fg, "function");
    return component;
  });
  await settleFactory();
  assert.equal(component.focused, true);
  assert.deepEqual(env.getViewport(), { columns: 118, rows: 30 });
  assert.equal(env.terminal.write, undefined);
  assert.deepEqual(f.frames[0].lines, ["width=92"]);
  done("answer");
  assert.equal(await result, "answer");
  assert.equal(component.focused, false);
  assert.equal(disposed, 1);
  assert.equal(env.signal.aborted, true);
  done("duplicate");
  assert.equal(disposed, 1);
});

test("synchronous done in factory settles and disposes the returned component exactly once", async () => {
  const f = fixture();
  let disposed = 0;
  const result = f.bridge.open((_tui, _theme, _keys, done) => {
    done(42);
    return { render: () => ["must not paint"], dispose: () => disposed++ };
  });
  assert.equal(await result, 42);
  await settleFactory();
  assert.equal(disposed, 1);
  assert.equal(f.frames.filter((frame) => !frame.closed).length, 0);
});

test("closing before an async factory resolves disposes its late component", async () => {
  const f = fixture();
  let release;
  let disposed = 0;
  const result = f.bridge.open(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await settleFactory();
  f.bridge.closeAll();
  assert.equal(await result, undefined);
  release({ render: () => ["late"], dispose: () => disposed++ });
  await settleFactory();
  assert.equal(disposed, 1);
  assert.equal(f.frames.filter((frame) => !frame.closed).length, 0);
});

test("disposing before factory invocation prevents startup", async () => {
  const f = fixture();
  let invoked = false;
  const result = f.bridge.open(() => {
    invoked = true;
    return { render: () => [] };
  });
  f.bridge.dispose();
  assert.equal(await result, undefined);
  await settleFactory();
  assert.equal(invoked, false);
  assert.equal(
    await f.bridge.open(() => {
      throw new Error("must not run");
    }),
    undefined,
  );
});

test("explicit close does not impersonate Ctrl+C or Escape", async () => {
  const f = fixture();
  const keys = [];
  let disposed = 0;
  const result = f.bridge.open(() => ({
    render: () => ["body"],
    handleInput: (data) => keys.push(data),
    dispose: () => disposed++,
  }));
  await settleFactory();
  f.bridge.action(f.id(), { kind: "close" });
  await result;
  assert.deepEqual(keys, []);
  assert.equal(disposed, 1);
});

test("Escape still belongs to the component", async () => {
  const f = fixture();
  let escape = 0;
  const result = f.bridge.open((_tui, _theme, _keys, done) => ({
    render: () => ["body"],
    handleInput: (data) => {
      if (data === "\x1b") {
        escape++;
        done();
      }
    },
  }));
  await settleFactory();
  f.bridge.input(f.id(), "\x1b");
  await result;
  assert.equal(escape, 1);
});

test("replacing a modal releases old ownership; stale keys and closes are ignored", async () => {
  const f = fixture();
  const keys = [];
  const first = f.bridge.open(() => ({ render: () => ["one"] }));
  await settleFactory();
  const oldId = f.id();
  const second = f.bridge.open(() => ({ render: () => ["two"], handleInput: (key) => keys.push(key) }));
  assert.equal(await first, undefined);
  await settleFactory();
  const newId = f.frames.filter((frame) => !frame.closed).at(-1).id;
  f.bridge.input(oldId, "x");
  f.bridge.action(oldId, { kind: "close" });
  f.bridge.input(newId, "y");
  assert.deepEqual(keys, ["y"]);
  f.bridge.closeAll();
  await second;
});

test("resize updates virtual dimensions, invalidates, and redraws", async () => {
  const f = fixture();
  let invalidations = 0;
  const result = f.bridge.open(
    (tui) => ({ render: (width) => [`${width}:${tui.terminal.rows}`], invalidate: () => invalidations++ }),
    { overlayOptions: { width: "78%", minWidth: 48 } },
  );
  await settleFactory();
  f.bridge.action(f.id(), { kind: "resize", columns: 100, rows: 50 });
  await delay(30);
  assert.deepEqual(f.frames.at(-1).lines, ["78:50"]);
  assert.equal(invalidations, 1);
  f.bridge.action(f.id(), { kind: "resize", columns: 100, rows: 50 });
  await delay(25);
  assert.equal(invalidations, 1);
  f.bridge.closeAll();
  await result;
});

test("streaming repaint bursts are coalesced and stop after close", async () => {
  const f = fixture();
  let env,
    text = "start";
  const result = f.bridge.open((tui) => {
    env = tui;
    return { render: () => [text] };
  });
  await settleFactory();
  for (let index = 0; index < 50; index++) {
    text = String(index);
    env.requestRender();
  }
  await delay(30);
  assert.equal(f.frames.filter((frame) => !frame.closed).length, 2);
  assert.deepEqual(f.frames.at(-1).lines, ["49"]);
  env.requestRender();
  f.bridge.closeAll();
  await result;
  const count = f.frames.length;
  env.requestRender();
  await delay(30);
  assert.equal(f.frames.length, count);
});

test("paste reaches input as one event, including the maximum accepted size", async () => {
  const f = fixture();
  const keys = [];
  const result = f.bridge.open(() => ({ render: () => ["body"], handleInput: (data) => keys.push(data) }));
  await settleFactory();
  f.bridge.action(f.id(), { kind: "paste", text: "one\ntwo" });
  f.bridge.action(f.id(), { kind: "paste", text: "x".repeat(MAX_CUSTOM_UI_INPUT) });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], bracketedPaste("one\ntwo"));
  f.bridge.closeAll();
  await result;
});

for (const [name, factory] of [
  [
    "throwing factory",
    () => {
      throw new Error("factory");
    },
  ],
  ["rejecting factory", () => Promise.reject(new Error("factory"))],
  ["invalid component", () => ({})],
  [
    "throwing render",
    () => ({
      render: () => {
        throw new Error("render");
      },
    }),
  ],
  ["invalid frame", () => ({ render: () => [123] })],
  ["oversized frame", () => ({ render: () => ["x".repeat(1_000_001)] })],
])
  test(`failure cleanup: ${name}`, async () => {
    const f = fixture();
    assert.equal(await f.bridge.open(factory), undefined);
    assert.equal(f.errors.length, 1);
    assert.equal(f.frames.at(-1).closed, true);
  });

test("throwing input is reported and disposes the component", async () => {
  const f = fixture();
  let disposed = 0;
  const result = f.bridge.open(() => ({
    render: () => [],
    handleInput: () => {
      throw new Error("input");
    },
    dispose: () => disposed++,
  }));
  await settleFactory();
  f.bridge.input(f.id(), "x");
  await result;
  assert.equal(disposed, 1);
  assert.equal(f.errors.length, 1);
});

test("throwing dispose and error observer cannot strand the promise", async () => {
  const frames = [];
  const bridge = new DesktopCustomUiBridge({
    frame: (frame) => frames.push(frame),
    error: () => {
      throw new Error("observer");
    },
  });
  const result = bridge.open(() => ({
    render: () => [],
    dispose: () => {
      throw new Error("dispose");
    },
  }));
  await settleFactory();
  bridge.closeAll();
  assert.equal(await result, undefined);
  assert.equal(frames.at(-1).closed, true);
});
