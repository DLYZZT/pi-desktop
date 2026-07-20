#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogs = ["runtime-catalog.json", "core-catalog.json"].map((name) =>
  JSON.parse(fs.readFileSync(path.join(root, "build", "toolchains", name), "utf8")),
);
const components = catalogs.flatMap((catalog) => catalog.components);
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Pi-Agent-Desktop-Toolchain-Catalog-Release-Check",
  ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
};

async function fetchChecked(url, init = {}) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
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

const nodeComponents = components.filter((component) => component.id === "node-lts");
const githubComponents = components.filter((component) => component.id !== "node-lts");
await verifyNodeComponents(nodeComponents);
await verifyGithubComponents(githubComponents);
console.log(
  `OK: ${nodeComponents.length + githubComponents.length} catalog releases match upstream checksums, digests, and artifact sizes`,
);
