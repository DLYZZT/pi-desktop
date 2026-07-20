#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!/^(?:darwin-(?:arm64|x64)|win32-x64|linux-x64)$/.test(target)) {
  throw new Error("Usage: verify-packaged-toolchains.mjs <darwin-arm64|darwin-x64|win32-x64|linux-x64>");
}
const [expectedPlatform, expectedArch] = target.split("-");
const layout = findPackagedLayout(dist, target);

verifyPackagedResources(layout.resources, target);
verifyBundledTools(layout.resources, expectedPlatform, expectedArch);
verifyLinuxSandbox(layout.executable, expectedPlatform);
runPackagedStartup(layout.executable, target);
if (layout.appImage) {
  verifyLinuxAppImageDesktopEntry(layout.appImage);
  runPackagedStartup(layout.appImage, target, { APPIMAGE_EXTRACT_AND_RUN: "1" });
}

console.log(
  `OK: ${target} packaged app starts through its production entry and contains only verified target toolchains`,
);

function findPackagedLayout(directory, toolTarget) {
  if (!fs.existsSync(directory)) throw new Error(`Missing package output: ${directory}`);
  const candidates = [];
  walkDirectories(directory, 5, (current) => {
    const normalized = current.split(path.sep).join("/");
    let resources;
    let executable;
    if (expectedPlatform === "darwin" && normalized.endsWith(".app/Contents")) {
      resources = path.join(current, "Resources");
      executable = path.join(current, "MacOS", "Pi Agent Desktop");
    } else if (/-unpacked$/i.test(path.basename(current))) {
      resources = path.join(current, "resources");
      if (expectedPlatform === "win32") executable = path.join(current, "Pi Agent Desktop.exe");
      else if (expectedPlatform === "linux") executable = path.join(current, "pi-agent-desktop");
    }
    if (
      resources &&
      executable &&
      regularFile(path.join(resources, "app.asar")) &&
      regularFile(executable) &&
      fs.existsSync(path.join(resources, "toolchains", "core", toolTarget))
    ) {
      candidates.push({ resources, executable });
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected one ${toolTarget} unpacked packaged layout, found ${candidates.length}`);
  }
  if (expectedPlatform !== "linux") return candidates[0];
  const appImages = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".AppImage") && regularFile(path.join(directory, name)))
    .map((name) => path.join(directory, name));
  if (appImages.length !== 1) throw new Error(`Expected one Linux AppImage, found ${appImages.length}`);
  return { ...candidates[0], appImage: appImages[0] };
}

function verifyPackagedResources(resources, toolTarget) {
  const toolchains = path.join(resources, "toolchains");
  const entries = fs.readdirSync(toolchains).sort();
  assertExact(entries, ["core", "core-catalog.json", "runtime-catalog.json"], "packaged toolchain resources");
  const coreTargets = fs
    .readdirSync(path.join(toolchains, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assertExact(coreTargets, [toolTarget], "packaged core target directories");
  const notice = path.join(resources, "THIRD_PARTY_NOTICES.md");
  if (!regularFile(notice)) throw new Error("Packaged third-party notices are missing");
  const noticeText = fs.readFileSync(notice, "utf8");
  for (const marker of [
    "ripgrep 15.2.0",
    "fd 10.3.0",
    "Node.js 24.18.0",
    "uv 0.11.29",
    "PortableGit 2.55.0.3",
    "jq 1.8.2",
    "Bun 1.3.14",
  ]) {
    if (!noticeText.includes(marker)) throw new Error(`Third-party notices are missing ${marker}`);
  }
  const runtimeCatalog = JSON.parse(fs.readFileSync(path.join(toolchains, "runtime-catalog.json"), "utf8"));
  const ids = runtimeCatalog.components?.map((component) => component.id).sort();
  assertExact(ids ?? [], ["bun", "cpython", "jq", "node-lts", "portable-git", "uv"], "managed runtime catalog IDs");

  const forbidden = [];
  walkFiles(toolchains, (file) => {
    const relative = path.relative(toolchains, file).split(path.sep).join("/");
    if (/(?:^|\/)(?:downloads|runtimes|staging|prefixes|caches)(?:\/|$)/i.test(relative)) forbidden.push(relative);
    if (/\.(?:partial|artifact|7z\.exe)$/i.test(relative)) forbidden.push(relative);
    if (/PortableGit-.*\.exe$/i.test(relative)) forbidden.push(relative);
  });
  if (forbidden.length > 0) throw new Error(`Packaged managed runtime residue: ${forbidden.join(", ")}`);
}

function verifyBundledTools(resources, platform, arch) {
  const targetRoot = path.join(resources, "toolchains", "core", `${platform}-${arch}`);
  const manifestPath = path.join(targetRoot, "manifests", "core-tools.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error("Packaged core manifest target does not match the application");
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length !== 2)
    throw new Error("Core manifest must contain rg and fd");
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length !== 4) {
    throw new Error("Core manifest must contain all rg/fd license files");
  }

  const byComponent = new Map();
  for (const tool of manifest.tools) {
    if (!["ripgrep", "fd"].includes(tool.componentId) || !safeRelativePath(tool.executable)) {
      throw new Error("Unsafe core tool manifest entry");
    }
    const executable = path.join(targetRoot, tool.executable);
    verifyManifestFile(executable, tool.sha256, tool.bytes);
    if (platform !== "win32" && (fs.statSync(executable).mode & 0o111) === 0) {
      throw new Error(`${tool.componentId} is not executable`);
    }
    byComponent.set(tool.componentId, executable);
  }
  for (const license of manifest.licenses) {
    if (!safeRelativePath(license.path)) throw new Error("Unsafe core license manifest entry");
    verifyManifestFile(path.join(targetRoot, license.path), license.sha256);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-packaged-core-"));
  try {
    const needleFile = path.join(temp, "needle.txt");
    fs.writeFileSync(needleFile, "packaged-toolchain-needle\n", "utf8");
    const rg = spawnSync(byComponent.get("ripgrep"), ["--json", "packaged-toolchain-needle", needleFile], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (rg.status !== 0 || !rg.stdout.includes('"type":"match"')) throw new Error(`Packaged rg failed: ${rg.stderr}`);
    const fd = spawnSync(byComponent.get("fd"), ["--glob", "needle.txt", temp], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (fd.status !== 0 || !fd.stdout.includes("needle.txt")) throw new Error(`Packaged fd failed: ${fd.stderr}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runPackagedStartup(executable, toolTarget, environmentPatch = {}) {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "pi-packaged-startup-"));
  const userData = path.join(isolated, "user-data");
  const environment = {
    ...process.env,
    HOME: isolated,
    USERPROFILE: isolated,
    APPDATA: path.join(isolated, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolated, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(isolated, ".config"),
    XDG_CACHE_HOME: path.join(isolated, ".cache"),
    XDG_DATA_HOME: path.join(isolated, ".local", "share"),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    ...environmentPatch,
  };
  try {
    const result = spawnSync(
      executable,
      [`--user-data-dir=${userData}`, "--validate-packaged-startup", "--disable-gpu"],
      {
        cwd: path.dirname(executable),
        env: environment,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Packaged startup exited ${result.status}: ${(result.stderr || result.stdout).slice(-4_000)}`);
    }
    const reports = [];
    walkFiles(isolated, (file) => {
      if (path.basename(file) === "packaged-startup-check.json") reports.push(file);
    });
    if (reports.length !== 1) throw new Error(`Expected one packaged startup report, found ${reports.length}`);
    const report = JSON.parse(fs.readFileSync(reports[0], "utf8"));
    if (
      report.ok !== true ||
      report.platformArch !== toolTarget ||
      report.rendererReady !== true ||
      report.hostReady !== true ||
      report.hostAckRevision !== report.revision
    ) {
      throw new Error(`Invalid packaged startup report: ${JSON.stringify(report)}`);
    }
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

function verifyLinuxAppImageDesktopEntry(appImage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-appimage-entry-"));
  try {
    const result = spawnSync(appImage, ["--appimage-extract", "*.desktop"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Could not inspect AppImage desktop entry: ${(result.stderr || result.stdout).slice(-2_000)}`);
    }
    const entries = [];
    walkFiles(path.join(directory, "squashfs-root"), (file) => {
      if (file.endsWith(".desktop")) entries.push(file);
    });
    if (entries.length !== 1) throw new Error(`Expected one AppImage desktop entry, found ${entries.length}`);
    const desktop = fs.readFileSync(entries[0], "utf8");
    if (!/^Exec=AppRun --appimage-desktop-launch %U$/m.test(desktop) || /--no-sandbox/.test(desktop)) {
      throw new Error("AppImage desktop entry must launch without disabling the Chromium sandbox");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verifyLinuxSandbox(executable, platform) {
  if (platform !== "linux") return;
  const sandbox = path.join(path.dirname(executable), "chrome-sandbox");
  const stat = fs.lstatSync(sandbox);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o4000) === 0) {
    throw new Error("Packaged Linux chrome-sandbox must be a root-owned setuid regular file for the startup E2E");
  }
}

function verifyManifestFile(file, expectedSha256, expectedBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Manifest target is not a regular file: ${file}`);
  if (expectedBytes !== undefined && stat.size !== expectedBytes) throw new Error(`Size mismatch: ${file}`);
  const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (sha256 !== expectedSha256) throw new Error(`SHA-256 mismatch: ${file}`);
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !value.split("/").includes("..")
  );
}

function assertExact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function walkDirectories(directory, remainingDepth, visit) {
  visit(directory);
  if (remainingDepth <= 0) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walkDirectories(path.join(directory, entry.name), remainingDepth - 1, visit);
    }
  }
}

function walkFiles(directory, visit) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walkFiles(entryPath, visit);
    else if (entry.isFile() && !entry.isSymbolicLink()) visit(entryPath);
  }
}
