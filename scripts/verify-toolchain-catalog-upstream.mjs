#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogs = ["runtime-catalog.json", "core-catalog.json"].map((name) =>
  JSON.parse(fs.readFileSync(path.join(root, "build", "toolchains", name), "utf8")),
);
const components = catalogs.flatMap((catalog) => catalog.components);
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
export function catalogRequestHeaders(url, token, overrides = {}) {
  const headers = new globalThis.Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "Pi-Agent-Desktop-Toolchain-Catalog-Release-Check",
    ...overrides,
  });
  headers.delete("authorization");
  if (token && new URL(url).origin === "https://api.github.com") headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function fetchChecked(url, init = {}, timeoutMs = 30_000) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: catalogRequestHeaders(url, githubToken, init.headers),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function artifactName(url) {
  const pathname = new URL(url).pathname;
  return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

async function verifyNodeComponents(components) {
  for (const component of components) {
    const checksumUrl = `https://nodejs.org/dist/v${component.version}/SHASUMS256.txt`;
    const checksumText = await (await fetchChecked(checksumUrl)).text();
    const checksums = new Map(
      checksumText
        .split(/\r?\n/)
        .map((line) => line.match(/^([a-f0-9]{64})\s+(.+)$/i))
        .filter(Boolean)
        .map((match) => [match[2], match[1].toLowerCase()]),
    );
    for (const variant of component.variants) {
      const name = artifactName(variant.url);
      if (checksums.get(name) !== variant.sha256) {
        throw new Error(`${component.id}@${component.version} ${name} does not match Node.js SHASUMS256.txt`);
      }
      const response = await fetchChecked(variant.url, { method: "HEAD", redirect: "follow" });
      const length = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length !== variant.downloadBytes) {
        throw new Error(`${component.id}@${component.version} ${name} size ${length} != ${variant.downloadBytes}`);
      }
    }
  }
}

function parseGithubReleaseUrl(url) {
  const parsed = new URL(url);
  const match = decodeURIComponent(parsed.pathname).match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Unsupported GitHub release artifact URL: ${url}`);
  return { owner: match[1], repo: match[2], tag: match[3], name: match[4] };
}

async function verifyGithubComponents(components) {
  const releases = new Map();
  for (const component of components) {
    for (const variant of component.variants) {
      const parsed = parseGithubReleaseUrl(variant.url);
      const key = `${parsed.owner}/${parsed.repo}@${parsed.tag}`;
      let assets = releases.get(key);
      if (!assets) {
        const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`;
        const release = await (
          await fetchChecked(apiUrl, { headers: { "X-GitHub-Api-Version": "2022-11-28" } })
        ).json();
        assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
        releases.set(key, assets);
      }
      const asset = assets.get(parsed.name);
      if (!asset) throw new Error(`${key} is missing release asset ${parsed.name}`);
      if (asset.size !== variant.downloadBytes) {
        throw new Error(`${key}/${parsed.name} size ${asset.size} != ${variant.downloadBytes}`);
      }
      if (asset.digest !== `sha256:${variant.sha256}`) {
        throw new Error(`${key}/${parsed.name} digest does not match the fixed catalog checksum`);
      }
    }
  }
}

const GOOGLE_PLATFORM_TOOLS_XML = "https://dl.google.com/android/repository/repository2-3.xml";

function parseGooglePlatformToolsMetadata(xml) {
  const start = xml.indexOf('<remotePackage path="platform-tools">');
  if (start < 0) throw new Error("Google repository metadata is missing platform-tools");
  const end = xml.indexOf("</remotePackage>", start);
  if (end < 0) throw new Error("Google platform-tools metadata is truncated");
  const block = xml.slice(start, end);
  const revision = block.match(
    /<revision>[\s\S]*?<major>(\d+)<\/major>[\s\S]*?<minor>(\d+)<\/minor>[\s\S]*?<micro>(\d+)<\/micro>/,
  );
  if (!revision) throw new Error("Google platform-tools metadata is missing a revision");
  const archives = new Map();
  for (const match of block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const body = match[1];
    const hostOs = body.match(/<host-os>([^<]+)<\/host-os>/)?.[1];
    const url = body.match(/<url>([^<]+)<\/url>/)?.[1];
    const size = Number(body.match(/<size>(\d+)<\/size>/)?.[1]);
    const sha1 = body.match(/<checksum type="sha1">([a-f0-9]{40})<\/checksum>/)?.[1];
    if (!hostOs || !url || !Number.isSafeInteger(size) || !sha1) {
      throw new Error("Google platform-tools metadata contains an incomplete archive");
    }
    archives.set(url, { hostOs, size, sha1 });
  }
  if (archives.size === 0) throw new Error("Google platform-tools metadata contains no archives");
  return { version: `${revision[1]}.${revision[2]}.${revision[3]}`, archives };
}

async function verifyGooglePlatformTools(components) {
  const metadata = parseGooglePlatformToolsMetadata(
    await (await fetchChecked(GOOGLE_PLATFORM_TOOLS_XML, {}, 120_000)).text(),
  );
  const variantsByUrl = new Map();
  for (const component of components) {
    for (const variant of component.variants) {
      const entries = variantsByUrl.get(variant.url) ?? [];
      entries.push({ component, variant });
      variantsByUrl.set(variant.url, entries);
    }
  }
  for (const [url, entries] of variantsByUrl) {
    const name = artifactName(url);
    const bytes = Buffer.from(await (await fetchChecked(url, {}, 120_000)).arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const { component, variant } of entries) {
      if (bytes.length !== variant.downloadBytes) {
        throw new Error(`${component.id}/${name} size ${bytes.length} != ${variant.downloadBytes}`);
      }
      if (sha256 !== variant.sha256) {
        throw new Error(`${component.id}/${name} sha256 does not match the fixed catalog checksum`);
      }
      const archive = metadata.archives.get(name);
      if (component.version === metadata.version && archive) {
        const sha1 = createHash("sha1").update(bytes).digest("hex");
        if (archive.size !== variant.downloadBytes || archive.sha1 !== sha1) {
          throw new Error(`${component.id}/${name} does not match the Google SDK repository metadata`);
        }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nodeComponents = components.filter((component) => component.id === "node-lts");
  const googleComponents = components.filter((component) => component.id === "platform-tools");
  const githubComponents = components.filter(
    (component) => component.id !== "node-lts" && component.id !== "platform-tools",
  );
  await verifyNodeComponents(nodeComponents);
  await verifyGooglePlatformTools(googleComponents);
  await verifyGithubComponents(githubComponents);
  console.log(
    `OK: ${nodeComponents.length + googleComponents.length + githubComponents.length} catalog releases match upstream checksums, digests, and artifact sizes`,
  );
}
