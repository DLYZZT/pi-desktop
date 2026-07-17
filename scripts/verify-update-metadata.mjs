#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseUpdateMetadata(document) {
  const versionMatch = document.match(/^version\s*:\s*([^#\r\n]+)/m);
  if (!versionMatch) throw new Error("Update metadata is missing version");

  const entries = [];
  let current = null;
  for (const line of document.split(/\r?\n/)) {
    const urlMatch = line.match(/^\s*-\s+url\s*:\s*(.+?)\s*$/);
    if (urlMatch) {
      current = { url: scalar(urlMatch[1]) };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const propertyMatch = line.match(/^\s+(sha512|size)\s*:\s*(.+?)\s*$/);
    if (propertyMatch) {
      current[propertyMatch[1]] = scalar(propertyMatch[2]);
    } else if (/^\S/.test(line)) {
      current = null;
    }
  }

  if (entries.length === 0) throw new Error("Update metadata contains no file entries");
  return { version: scalar(versionMatch[1]), entries };
}

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

export async function verifyUpdateMetadata(metadataFile, expectedVersion, artifactFiles) {
  const document = readFileSync(metadataFile, "utf8");
  const metadata = parseUpdateMetadata(document);
  if (metadata.version !== expectedVersion) {
    throw new Error(`${metadataFile}: version ${metadata.version} does not match ${expectedVersion}`);
  }

  const expected = new Map(artifactFiles.map((file) => [path.basename(file), file]));
  const actualNames = metadata.entries.map((entry) => entry.url);
  if (new Set(actualNames).size !== actualNames.length) {
    throw new Error(`${metadataFile}: duplicate file entries are not allowed`);
  }
  if (metadata.entries.length !== expected.size || actualNames.some((name) => !expected.has(name))) {
    throw new Error(
      `${metadataFile}: metadata files (${actualNames.sort().join(", ")}) do not exactly match expected artifacts (${[
        ...expected.keys(),
      ]
        .sort()
        .join(", ")})`,
    );
  }

  for (const entry of metadata.entries) {
    const file = expected.get(entry.url);
    if (!file) throw new Error(`${metadataFile}: unexpected artifact ${entry.url}`);
    const fileStats = statSync(file);
    const expectedSize = Number(entry.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize !== fileStats.size) {
      throw new Error(`${metadataFile}: size mismatch for ${entry.url}`);
    }
    const digest = await sha512(file);
    if (entry.sha512 !== digest) {
      throw new Error(`${metadataFile}: SHA-512 mismatch for ${entry.url}`);
    }
    const blockmap = `${file}.blockmap`;
    if (!statSync(blockmap).isFile() || statSync(blockmap).size === 0) {
      throw new Error(`${blockmap}: blockmap is missing or empty`);
    }
  }
}

async function main() {
  const [metadataFile, expectedVersion, ...artifactFiles] = process.argv.slice(2);
  if (!metadataFile || !expectedVersion || artifactFiles.length === 0) {
    throw new Error("Usage: verify-update-metadata.mjs <latest.yml> <version> <artifact> [artifact ...]");
  }
  await verifyUpdateMetadata(metadataFile, expectedVersion, artifactFiles);
  console.log(`Validated ${metadataFile} against ${artifactFiles.length} update artifact(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
