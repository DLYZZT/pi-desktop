import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES,
  WINDOWS_HELPER_CONTROL_MAX_BYTES,
  WINDOWS_HELPER_HEADER_BYTES,
  WINDOWS_HELPER_KIND,
  WINDOWS_HELPER_OUTPUT_MAX_BYTES,
  WindowsHelperFrameDecoder,
  encodeWindowsHelperFrame,
  encodeWindowsHelperJson,
  parseWindowsHelperJson,
} from "./helper-codec.ts";

test("Windows helper codec handles fragmented and coalesced frames", () => {
  const first = encodeWindowsHelperJson(WINDOWS_HELPER_KIND.hello, 1, { protocolVersion: 1 });
  const second = encodeWindowsHelperFrame(WINDOWS_HELPER_KIND.stdout, 2, Buffer.from([0, 10, 255]));
  const bytes = Buffer.concat([first, second]);
  const decoder = new WindowsHelperFrameDecoder();
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += 3) {
    frames.push(...decoder.push(bytes.subarray(offset, offset + 3)));
  }
  decoder.finish();
  assert.deepEqual(parseWindowsHelperJson(frames[0]), { protocolVersion: 1 });
  assert.deepEqual([...frames[1].payload], [0, 10, 255]);
});

test("Windows helper codec rejects unknown kinds, sequence replay, truncation, and oversize before payload", () => {
  assert.throws(() => encodeWindowsHelperFrame(0xffff, 1, "{}"));
  const frame = encodeWindowsHelperFrame(WINDOWS_HELPER_KIND.hello, 2, "{}");
  assert.throws(() => new WindowsHelperFrameDecoder().push(frame), /header/u);
  const truncated = encodeWindowsHelperFrame(WINDOWS_HELPER_KIND.stdout, 1, "x").subarray(
    0,
    WINDOWS_HELPER_HEADER_BYTES,
  );
  const truncatedDecoder = new WindowsHelperFrameDecoder();
  truncatedDecoder.push(truncated);
  assert.throws(() => truncatedDecoder.finish(), /Truncated/u);
  const oversized = Buffer.alloc(WINDOWS_HELPER_HEADER_BYTES);
  oversized.write("PIMP", 0, 4, "ascii");
  oversized.writeUInt16LE(1, 4);
  oversized.writeUInt16LE(WINDOWS_HELPER_KIND.bootstrap, 6);
  oversized.writeUInt32LE(WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES + 1, 8);
  oversized.writeUInt32LE(1, 12);
  assert.throws(() => new WindowsHelperFrameDecoder().push(oversized), /header/u);
});

test("Windows helper codec enforces exact bootstrap, control, and output boundaries", () => {
  for (const [kind, limit] of [
    [WINDOWS_HELPER_KIND.bootstrap, WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES],
    [WINDOWS_HELPER_KIND.stop, WINDOWS_HELPER_CONTROL_MAX_BYTES],
    [WINDOWS_HELPER_KIND.stdout, WINDOWS_HELPER_OUTPUT_MAX_BYTES],
  ]) {
    const accepted = encodeWindowsHelperFrame(kind, 1, Buffer.alloc(limit));
    const decoder = new WindowsHelperFrameDecoder();
    assert.equal(decoder.push(accepted)[0].payload.length, limit);
    decoder.finish();
    assert.throws(() => encodeWindowsHelperFrame(kind, 1, Buffer.alloc(limit + 1)), /Invalid/u);
  }

  const unknownVersion = encodeWindowsHelperFrame(WINDOWS_HELPER_KIND.stop, 1, "{}");
  unknownVersion.writeUInt16LE(2, 4);
  assert.throws(() => new WindowsHelperFrameDecoder().push(unknownVersion), /protocol mismatch/u);

  const unknownKind = Buffer.alloc(WINDOWS_HELPER_HEADER_BYTES);
  unknownKind.write("PIMP", 0, 4, "ascii");
  unknownKind.writeUInt16LE(1, 4);
  unknownKind.writeUInt16LE(0xffff, 6);
  unknownKind.writeUInt32LE(0, 8);
  unknownKind.writeUInt32LE(1, 12);
  assert.throws(() => new WindowsHelperFrameDecoder().push(unknownKind), /header/u);
});

test("Windows helper codec handles a bounded deterministic random-byte corpus without unbounded buffering", () => {
  let state = 0x51f15e;
  for (let sample = 0; sample < 2_000; sample += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const bytes = Buffer.alloc(state % 1_025);
    for (let index = 0; index < bytes.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    const decoder = new WindowsHelperFrameDecoder();
    try {
      decoder.push(bytes);
      decoder.finish();
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});
