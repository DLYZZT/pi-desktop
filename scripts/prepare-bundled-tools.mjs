#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeCatalog } from "../src/shared/toolchains/catalog-schema.ts";
import { findComponentEntrypoint } from "../src/main/toolchains/component-entrypoint.ts";
import { downloadRuntimeArtifact, hashFile, verifyDownloadedArtifact } from "../src/main/toolchains/downloader.ts";
import { extractRuntimeArchive } from "../src/main/toolchains/secure-extractor.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "build", "toolchains", "core-catalog.json");
const outputRoot = path.join(root, "build", "toolchains", "core");
const cacheRoot = path.join(root, "build", "toolchains", ".core-cache");
const releasedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
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

function parseTargets(argv) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const target = argv[index + 1];
      if (!target) fail("--target requires platform-arch");
      targets.push(target);
      index += 1;
    } else if (argument === "--all") {
      targets.push(...releasedTargets);
    } else if (argument === "--release") {
      targets.push(...(process.platform === "darwin" ? ["darwin-arm64", "darwin-x64"] : [`${process.platform}-x64`]));
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (targets.length === 0) targets.push(`${process.platform}-${process.arch}`);
  const unique = [...new Set(targets)];
  for (const target of unique) {
    if (!releasedTargets.has(target)) fail(`unsupported release target: ${target}`);
  }
  return unique;
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
  try {
    const response = await globalThis.fetch(definition.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Pi-Agent-Desktop-Bundled-Tools-Build" },
    });
    if (!response.ok) fail(`${definition.url} returned HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.length !== definition.bytes || digest !== definition.sha256) {
      fail(`${definition.name} failed fixed license verification`);
    }
    const temporary = `${destination}.${randomUUID()}.partial`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    clearTimeout(timer);
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

const catalog = parseRuntimeCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
for (const target of parseTargets(process.argv.slice(2))) await prepareTarget(catalog, target);
