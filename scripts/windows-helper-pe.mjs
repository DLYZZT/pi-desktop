import fs from "node:fs";

const REQUIRED_DLL_CHARACTERISTICS = {
  highEntropyVa: 0x0020,
  dynamicBase: 0x0040,
  nxCompat: 0x0100,
  guardCf: 0x4000,
};

const ALLOWED_IMPORTS = new Set([
  "advapi32.dll",
  "api-ms-win-core-synch-l1-2-0.dll",
  "kernel32.dll",
  "ntdll.dll",
  "user32.dll",
]);

function assertRange(bytes, offset, size, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
    throw new Error(`Windows helper PE ${label} is out of range`);
  }
}

function readCString(bytes, offset) {
  assertRange(bytes, offset, 1, "string");
  const end = bytes.indexOf(0, offset);
  if (end < 0 || end - offset > 260) throw new Error("Windows helper PE import name is unterminated or oversized");
  const value = bytes.subarray(offset, end).toString("ascii");
  if (!/^[A-Za-z0-9._-]+\.dll$/u.test(value)) throw new Error("Windows helper PE import name is invalid");
  return value;
}

export function verifyWindowsHelperPe(filePath) {
  const bytes = fs.readFileSync(filePath);
  assertRange(bytes, 0, 0x40, "DOS header");
  if (bytes.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("Windows managed process helper is not a PE executable");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  assertRange(bytes, peOffset, 24, "COFF header");
  if (bytes.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\0\0") {
    throw new Error("Windows managed process helper has an invalid PE signature");
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("Windows managed process helper is not x86-64");
  }
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  assertRange(bytes, optionalOffset, optionalSize, "optional header");
  if (optionalSize < 240 || bytes.readUInt16LE(optionalOffset) !== 0x20b) {
    throw new Error("Windows managed process helper is not PE32+");
  }
  const subsystem = bytes.readUInt16LE(optionalOffset + 0x44);
  if (subsystem !== 3) throw new Error(`Windows helper PE has unexpected subsystem ${subsystem}`);
  const dllCharacteristics = bytes.readUInt16LE(optionalOffset + 0x46);
  for (const [name, flag] of Object.entries(REQUIRED_DLL_CHARACTERISTICS)) {
    if ((dllCharacteristics & flag) !== flag) throw new Error(`Windows helper PE is missing ${name} mitigation`);
  }

  const sectionOffset = optionalOffset + optionalSize;
  assertRange(bytes, sectionOffset, sectionCount * 40, "section table");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    const virtualSize = bytes.readUInt32LE(offset + 8);
    const virtualAddress = bytes.readUInt32LE(offset + 12);
    const rawSize = bytes.readUInt32LE(offset + 16);
    const rawOffset = bytes.readUInt32LE(offset + 20);
    if (rawSize > 0) assertRange(bytes, rawOffset, rawSize, "section data");
    sections.push({ virtualAddress, size: Math.max(virtualSize, rawSize), rawOffset });
  }
  const rvaToOffset = (rva, label) => {
    const section = sections.find(
      (candidate) => rva >= candidate.virtualAddress && rva < candidate.virtualAddress + candidate.size,
    );
    if (!section) throw new Error(`Windows helper PE ${label} RVA is not mapped`);
    const offset = section.rawOffset + rva - section.virtualAddress;
    assertRange(bytes, offset, 1, label);
    return offset;
  };

  const dataDirectoryOffset = optionalOffset + 0x70;
  const importRva = bytes.readUInt32LE(dataDirectoryOffset + 8);
  const importSize = bytes.readUInt32LE(dataDirectoryOffset + 12);
  if (importRva === 0 || importSize < 20) throw new Error("Windows helper PE has no import directory");
  let importOffset = rvaToOffset(importRva, "import directory");
  const imports = [];
  for (let index = 0; index < 64; index += 1, importOffset += 20) {
    assertRange(bytes, importOffset, 20, "import descriptor");
    const fields = Array.from({ length: 5 }, (_, field) => bytes.readUInt32LE(importOffset + field * 4));
    if (fields.every((field) => field === 0)) break;
    if (fields[3] === 0) throw new Error("Windows helper PE import descriptor has no name");
    imports.push(readCString(bytes, rvaToOffset(fields[3], "import name")));
  }
  if (imports.length === 0 || imports.length >= 64) throw new Error("Windows helper PE import table is invalid");
  const unexpectedImports = [...new Set(imports.map((value) => value.toLowerCase()))].filter(
    (value) => !ALLOWED_IMPORTS.has(value),
  );
  if (unexpectedImports.length > 0) {
    throw new Error(`Windows helper PE has unexpected runtime imports: ${unexpectedImports.join(", ")}`);
  }

  const resourceRva = bytes.readUInt32LE(dataDirectoryOffset + 16);
  const resourceSize = bytes.readUInt32LE(dataDirectoryOffset + 20);
  if (resourceRva === 0 || resourceSize < 16) throw new Error("Windows helper PE has no resource directory");
  const resourceOffset = rvaToOffset(resourceRva, "resource directory");
  assertRange(bytes, resourceOffset, 16, "resource directory");
  const resourceCount = bytes.readUInt16LE(resourceOffset + 12) + bytes.readUInt16LE(resourceOffset + 14);
  assertRange(bytes, resourceOffset + 16, resourceCount * 8, "resource entries");
  const resourceTypes = [];
  for (let index = 0; index < resourceCount; index += 1) {
    const name = bytes.readUInt32LE(resourceOffset + 16 + index * 8);
    if ((name & 0x8000_0000) === 0) resourceTypes.push(name);
  }
  for (const required of [16, 24]) {
    if (!resourceTypes.includes(required)) {
      throw new Error(`Windows helper PE is missing resource type ${required}`);
    }
  }

  return {
    architecture: "x64",
    subsystem: "console",
    dllCharacteristics,
    imports,
    resourceTypes,
  };
}
