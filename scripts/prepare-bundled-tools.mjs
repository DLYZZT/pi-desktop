#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeCatalog } from "../src/shared/toolchains/catalog-schema.ts";
import { parseHerdrRuntimeCatalog } from "../src/main/herdr/catalog.ts";
import { findComponentEntrypoint } from "../src/main/toolchains/component-entrypoint.ts";
import {
  assertRuntimeRedirectUrl,
  downloadRuntimeArtifact,
  hashFile,
  MAX_RUNTIME_REDIRECTS,
  verifyDownloadedArtifact,
} from "../src/main/toolchains/downloader.ts";
import { extractRuntimeArchive } from "../src/main/toolchains/secure-extractor.ts";
import { darwinCodeDigest } from "../src/main/toolchains/darwin-binary-integrity.ts";
import { parseBundledToolTargets } from "./bundled-tools-targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "build", "toolchains", "core-catalog.json");
const outputRoot = path.join(root, "build", "toolchains", "core");
const cacheRoot = path.join(root, "build", "toolchains", ".core-cache");
const herdrCatalogPath = path.join(root, "build", "herdr", "runtime-catalog.json");
const herdrOutputRoot = path.join(root, "build", "herdr", "bin");
const herdrCacheRoot = path.join(root, "build", "herdr", ".cache");
const herdrLicense = {
  name: "Herdr-LICENSE",
  url: "https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/LICENSE",
  bytes: 11357,
  sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
};
const licenseFiles = {
  ripgrep: [
    {
      name: "ripgrep-LICENSE-MIT",
      url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT",
      bytes: 1081,
      sha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    },
    {
      name: "ripgrep-UNLICENSE",
      url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE",
      bytes: 1211,
      sha256: "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
    },
  ],
  fd: [
    {
      name: "fd-LICENSE-MIT",
      url: "https://raw.githubusercontent.com/sharkdp/fd/v10.3.0/LICENSE-MIT",
      bytes: 1082,
      sha256: "322cfc7aa0c774d0eca3b2610f1d414de3ddbd7d8dd4b9dea941a13a6eb07455",
    },
    {
      name: "fd-LICENSE-APACHE",
      url: "https://raw.githubusercontent.com/sharkdp/fd/v10.3.0/LICENSE-APACHE",
      bytes: 10838,
      sha256: "73c83c60d817e7df1943cb3f0af81e4939a8352c9a96c2fd00451b1116fa635c",
    },
  ],
};

function fail(message) {
  throw new Error(`[bundled-tools] ${message}`);
}

async function downloadFixedFile(definition, destination) {
  try {
    const existing = await hashFile(destination);
    if (existing.bytes === definition.bytes && existing.sha256 === definition.sha256) return;
  } catch {
    // Missing or stale cache entries are replaced below.
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    let current = assertRuntimeRedirectUrl(definition.url);
    let response;
    for (let redirects = 0; redirects <= MAX_RUNTIME_REDIRECTS; redirects += 1) {
      response = await globalThis.fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Pi-Agent-Desktop-Bundled-Tools-Build", "Accept-Encoding": "identity" },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirects === MAX_RUNTIME_REDIRECTS) fail(`${definition.url} exceeded redirect limits`);
      current = assertRuntimeRedirectUrl(new URL(location, current).href);
    }
    if (!response.ok) fail(`${definition.url} returned HTTP ${response.status}`);
    if (!response.body) fail(`${definition.url} returned an empty body`);
    const hash = createHash("sha256");
    let bytes = 0;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > definition.bytes) fail(`${definition.name} exceeded its fixed size`);
        hash.update(chunk);
        fs.writeSync(descriptor, chunk);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    if (bytes !== definition.bytes || hash.digest("hex") !== definition.sha256) {
      fail(`${definition.name} failed fixed license verification`);
    }
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    clearTimeout(timer);
    fs.rmSync(temporary, { force: true });
  }
}

async function prepareTarget(catalog, target) {
  const separator = target.lastIndexOf("-");
  const platform = target.slice(0, separator);
  const arch = target.slice(separator + 1);
  const selected = catalog.components.map((component) => ({
    component,
    variant: component.variants.find((variant) => variant.platform === platform && variant.arch === arch),
  }));
  if (selected.some(({ variant }) => !variant)) fail(`${target} is missing a core tool variant`);

  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(outputRoot, `.${target}-staging-`));
  const extractionRoots = [];
  try {
    fs.mkdirSync(path.join(staging, "manifests"), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(staging, "licenses"), { recursive: true, mode: 0o755 });
    const tools = [];
    const licenses = [];
    for (const { component, variant } of selected) {
      const artifact = path.join(cacheRoot, `${component.id}-${component.version}-${target}.artifact`);
      if (!(await verifyDownloadedArtifact(artifact, variant))) {
        console.log(`[bundled-tools] downloading ${component.id}@${component.version} for ${target}`);
        await downloadRuntimeArtifact(component.id, variant, artifact);
      }
      if (!(await verifyDownloadedArtifact(artifact, variant))) fail(`${component.id} artifact verification failed`);

      const extractionRoot = fs.mkdtempSync(path.join(cacheRoot, `${component.id}-extract-`));
      extractionRoots.push(extractionRoot);
      await extractRuntimeArchive(artifact, extractionRoot, variant.archive, {
        maxExtractedBytes: 128 * 1024 * 1024,
      });
      const source = findComponentEntrypoint(component.id, extractionRoot).executable;
      const executableName = `${component.id === "ripgrep" ? "rg" : "fd"}${platform === "win32" ? ".exe" : ""}`;
      const destination = path.join(staging, executableName);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (platform !== "win32") fs.chmodSync(destination, 0o755);
      const binary = await hashFile(destination);
      const darwinCode = platform === "darwin" ? darwinCodeDigest(fs.readFileSync(destination)) : undefined;
      if (platform === "darwin" && !darwinCode) fail(`${component.id} is not a supported Mach-O executable`);

      const componentLicenses = licenseFiles[component.id];
      if (!componentLicenses) fail(`missing license definition for ${component.id}`);
      for (const license of componentLicenses) {
        const cachedLicense = path.join(cacheRoot, "licenses", license.name);
        await downloadFixedFile(license, cachedLicense);
        fs.copyFileSync(cachedLicense, path.join(staging, "licenses", license.name), fs.constants.COPYFILE_EXCL);
        licenses.push({
          componentId: component.id,
          path: `licenses/${license.name}`,
          sourceUrl: license.url,
          sha256: license.sha256,
        });
      }
      tools.push({
        componentId: component.id,
        capability: component.provides[0],
        version: component.version,
        executable: executableName,
        sha256: binary.sha256,
        bytes: binary.bytes,
        ...(darwinCode ? { darwinCodeSha256: darwinCode.sha256, darwinCodeBytes: darwinCode.bytes } : {}),
        artifactSha256: variant.sha256,
      });
    }
    const manifest = {
      schemaVersion: 1,
      catalogRevision: catalog.revision,
      platform,
      arch,
      tools,
      licenses,
    };
    fs.writeFileSync(path.join(staging, "manifests", "core-tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const destination = path.join(outputRoot, target);
    const previous = `${destination}.previous-${randomUUID()}`;
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staging, destination);
      fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    console.log(
      `[bundled-tools] prepared ${target}: ${tools.map((tool) => `${tool.componentId}@${tool.version}`).join(", ")}`,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const extractionRoot of extractionRoots) fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

async function prepareHerdrTarget(catalog, target) {
  if (target === "win32-x64") {
    console.log(`[bundled-tools] Herdr remains unsupported for ${target}; no runtime was bundled`);
    return;
  }
  const separator = target.lastIndexOf("-");
  const platform = target.slice(0, separator);
  const arch = target.slice(separator + 1);
  const artifact = catalog.artifacts[target];
  if (!artifact) fail(`${target} is missing a Herdr runtime artifact`);

  fs.mkdirSync(herdrOutputRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(herdrCacheRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(herdrOutputRoot, `.${target}-staging-`));
  try {
    const cachedBinary = path.join(herdrCacheRoot, `herdr-${catalog.version}-${target}`);
    await downloadFixedFile(
      {
        name: `herdr-${catalog.version}-${target}`,
        url: artifact.url,
        bytes: artifact.downloadBytes,
        sha256: artifact.sha256,
      },
      cachedBinary,
    );
    const executable = path.join(staging, "herdr");
    fs.copyFileSync(cachedBinary, executable, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(executable, 0o755);
    const binary = await hashFile(executable);
    if (binary.bytes !== artifact.downloadBytes || binary.sha256 !== artifact.sha256) {
      fail(`Herdr ${target} failed bundled binary verification`);
    }
    const darwinCode = platform === "darwin" ? darwinCodeDigest(fs.readFileSync(executable)) : undefined;
    if (platform === "darwin" && !darwinCode) fail(`Herdr ${target} is not a supported Mach-O executable`);

    const cachedLicense = path.join(herdrCacheRoot, herdrLicense.name);
    await downloadFixedFile(herdrLicense, cachedLicense);
    fs.copyFileSync(cachedLicense, path.join(staging, "LICENSE"), fs.constants.COPYFILE_EXCL);
    const manifest = {
      schemaVersion: 1,
      version: catalog.version,
      protocol: catalog.protocol,
      apiSchemaVersion: catalog.apiSchemaVersion,
      apiSchemaSha256: catalog.apiSchemaSha256,
      platform,
      arch,
      executable: "herdr",
      sha256: binary.sha256,
      bytes: binary.bytes,
      artifactSha256: artifact.sha256,
      ...(darwinCode ? { darwinCodeSha256: darwinCode.sha256, darwinCodeBytes: darwinCode.bytes } : {}),
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const destination = path.join(herdrOutputRoot, target);
    const previous = `${destination}.previous-${randomUUID()}`;
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staging, destination);
      fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    console.log(`[bundled-tools] prepared ${target}: herdr@${catalog.version}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const catalog = parseRuntimeCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
const herdrCatalog = parseHerdrRuntimeCatalog(JSON.parse(fs.readFileSync(herdrCatalogPath, "utf8")));
for (const target of parseBundledToolTargets(process.argv.slice(2))) {
  await prepareTarget(catalog, target);
  await prepareHerdrTarget(herdrCatalog, target);
}
