import { createReadStream, existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function listFilesRecursively(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

async function scanFile(file, markers) {
  const overlap = Math.max(0, ...markers.map(({ value }) => Buffer.byteLength(value))) - 1;
  let tail = "";
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const text = `${tail}${chunk.toString("utf8")}`;
      const marker = markers.find(({ value }) => text.includes(value));
      if (marker) return marker.label;
      tail = overlap > 0 ? text.slice(-overlap) : "";
    }
  } catch {
    // Locked/transient binary files do not make the harness itself unsafe.
  }
  return undefined;
}

export async function findSensitiveLeaks(directories, markers) {
  const leaks = [];
  for (const directory of directories) {
    for (const file of listFilesRecursively(directory)) {
      const label = await scanFile(file, markers);
      if (label) leaks.push({ file, label });
    }
  }
  return leaks;
}
