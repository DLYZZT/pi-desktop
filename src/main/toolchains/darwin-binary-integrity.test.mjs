import assert from "node:assert/strict";
import test from "node:test";
import { darwinCodeDigest } from "./darwin-binary-integrity.ts";

function unsignedMachO() {
  const binary = Buffer.alloc(256);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(72, 20);
  binary.writeUInt32LE(0x19, 32);
  binary.writeUInt32LE(72, 36);
  binary.write("__LINKEDIT", 40, "utf8");
  binary.writeBigUInt64LE(0x4_000n, 64);
  binary.writeBigUInt64LE(0x80n, 80);
  binary.write("fixed executable code", 128, "utf8");
  return binary;
}

function signedMachO(unsigned) {
  const binary = Buffer.alloc(320);
  unsigned.copy(binary);
  binary.writeUInt32LE(2, 16);
  binary.writeUInt32LE(88, 20);
  binary.writeBigUInt64LE(0x8_000n, 64);
  binary.writeBigUInt64LE(0x100n, 80);
  binary.writeUInt32LE(0x1d, 104);
  binary.writeUInt32LE(16, 108);
  binary.writeUInt32LE(264, 112);
  binary.writeUInt32LE(32, 116);
  binary.fill(0xa5, 264, 296);
  return binary;
}

test("keeps the executable digest stable when codesign replaces or adds a Mach-O signature", () => {
  const unsigned = unsignedMachO();
  const expected = darwinCodeDigest(unsigned);
  assert.ok(expected);
  assert.equal(expected.bytes, unsigned.length);
  assert.deepEqual(darwinCodeDigest(signedMachO(unsigned), expected.bytes), expected);
});

test("rejects modified executable bytes and non-zero signing alignment padding", () => {
  const unsigned = unsignedMachO();
  const expected = darwinCodeDigest(unsigned);
  assert.ok(expected);

  const modified = signedMachO(unsigned);
  modified[140] ^= 0xff;
  assert.notEqual(darwinCodeDigest(modified, expected.bytes)?.sha256, expected.sha256);

  const hiddenPadding = signedMachO(unsigned);
  hiddenPadding[260] = 1;
  assert.equal(darwinCodeDigest(hiddenPadding, expected.bytes), undefined);
});

test("rejects malformed Mach-O load commands and signature ranges", () => {
  const malformed = unsignedMachO();
  malformed.writeUInt32LE(4_097, 16);
  assert.equal(darwinCodeDigest(malformed), undefined);

  const invalidSignature = signedMachO(unsignedMachO());
  invalidSignature.writeUInt32LE(invalidSignature.length, 112);
  assert.equal(darwinCodeDigest(invalidSignature, 256), undefined);
});
