#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { darwinCodeDigest } from "../src/main/toolchains/darwin-binary-integrity.ts";
import { extractFile, listPackage } from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies?.[
  "@earendil-works/pi-coding-agent"
];
const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const argumentsList = process.argv.slice(2);
const target = argumentsList.shift() ?? `${process.platform}-${process.arch}`;
let outputArgument;
let staticOnly = false;
for (const argument of argumentsList) {
  if (argument === "--static" && !staticOnly) staticOnly = true;
  else if (!argument.startsWith("--") && !outputArgument) outputArgument = argument;
  else {
    throw new Error(
      "Usage: verify-packaged-toolchains.mjs <darwin-arm64|darwin-x64|win32-x64|linux-x64> [package-output-directory] [--static]",
    );
  }
}
if (!/^(?:darwin-(?:arm64|x64)|win32-x64|linux-x64)$/.test(target)) {
  throw new Error(
    "Usage: verify-packaged-toolchains.mjs <darwin-arm64|darwin-x64|win32-x64|linux-x64> [package-output-directory] [--static]",
  );
}
const dist = outputArgument ? path.resolve(outputArgument) : path.join(root, "dist");
const [expectedPlatform, expectedArch] = target.split("-");
const layout = findPackagedLayout(dist, target);

verifyPackagedResources(layout.resources, target);
verifyPiRuntimeAssets(layout.resources, expectedPlatform, expectedArch);
verifyBundledTools(layout.resources, expectedPlatform, expectedArch, !staticOnly);
verifyLinuxSandbox(layout.executable, expectedPlatform);
if (!staticOnly) {
  runPackagedStartup(layout.executable, target);
  if (layout.appImage) {
    verifyLinuxAppImageDesktopEntry(layout.appImage);
    // Extraction mode writes chrome-sandbox into a user-owned temporary directory, so it cannot retain the
    // root-owned 4755 metadata required by Chromium. The unpacked layout startup above already exercises the
    // configured SUID sandbox; this second launch verifies the AppImage entry point and production resources.
    runPackagedStartup(layout.appImage, target, { APPIMAGE_EXTRACT_AND_RUN: "1" }, ["--no-sandbox"]);
  }
}

console.log(
  staticOnly
    ? `OK: ${target} packaged resources and target toolchains pass static verification (executables not run)`
    : `OK: ${target} packaged app starts through its production entry and contains only verified target toolchains`,
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
  for (const [component, version] of [
    ["ripgrep", "15.2.0"],
    ["fd", "10.3.0"],
    ["Node.js", "24.18.0"],
    ["uv", "0.11.29"],
    ["PortableGit", "2.55.0.3"],
    ["jq", "1.8.2"],
    ["Bun", "1.3.14"],
  ]) {
    const tableRow = new RegExp(`^\\|\\s*${escapeRegExp(component)}\\s*\\|\\s*${escapeRegExp(version)}\\s*\\|`, "m");
    if (!tableRow.test(noticeText)) throw new Error(`Third-party notices are missing ${component} ${version}`);
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

function verifyPiRuntimeAssets(resources, platform, arch) {
  const asarPath = path.join(resources, "app.asar");
  const entries = new Set(listPackage(asarPath).map((entry) => entry.replace(/^[/\\]+/u, "").replaceAll("\\", "/")));
  const codingAgentRoot = "node_modules/@earendil-works/pi-coding-agent";
  const nested = `${codingAgentRoot}/node_modules`;
  const required = [
    `${codingAgentRoot}/package.json`,
    `${codingAgentRoot}/dist/index.js`,
    `${codingAgentRoot}/dist/index.d.ts`,
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-ai/dist/index.js",
    "node_modules/@earendil-works/pi-ai/dist/index.d.ts",
    "node_modules/@earendil-works/pi-telemetry/package.json",
    "node_modules/@earendil-works/pi-telemetry/dist/index.js",
    "node_modules/@earendil-works/pi-telemetry/dist/index.d.ts",
    "node_modules/@earendil-works/pi-agent-core/package.json",
    "node_modules/@earendil-works/pi-agent-core/dist/index.js",
    `${nested}/@earendil-works/pi-ai/package.json`,
    `${nested}/@earendil-works/pi-ai/dist/index.js`,
    `${nested}/@earendil-works/pi-ai/dist/index.d.ts`,
    `${nested}/@earendil-works/pi-ai/dist/providers/data/amazon-bedrock.json`,
    `${nested}/@earendil-works/pi-client/package.json`,
    `${nested}/@earendil-works/pi-client/dist/index.js`,
    `${nested}/@earendil-works/pi-client/dist/index.d.ts`,
    `${nested}/@earendil-works/pi-protocol/package.json`,
    `${nested}/@earendil-works/pi-protocol/dist/index.js`,
    `${nested}/@earendil-works/pi-protocol/dist/index.d.ts`,
    `${nested}/@earendil-works/pi-telemetry/package.json`,
    `${nested}/@earendil-works/pi-telemetry/dist/index.js`,
    `${nested}/@earendil-works/pi-telemetry/dist/index.d.ts`,
    `${nested}/@earendil-works/pi-tui/package.json`,
    `${nested}/@earendil-works/pi-tui/dist/index.js`,
    `${nested}/@earendil-works/pi-tui/dist/index.d.ts`,
    "node_modules/grok-mermaid/package.json",
    "node_modules/grok-mermaid/dist/index.js",
  ];
  if (platform === "darwin") {
    required.push(`${nested}/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-${arch}/darwin-modifiers.node`);
  } else if (platform === "win32") {
    required.push(`${nested}/@earendil-works/pi-tui/native/win32/prebuilds/win32-${arch}/win32-console-mode.node`);
    required.push(
      "node_modules/@mariozechner/clipboard-win32-x64-msvc/package.json",
      "node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
    );
  }
  const missing = required.filter((entry) => !entries.has(entry));
  if (missing.length > 0) throw new Error(`Packaged Pi runtime/authoring assets are missing: ${missing.join(", ")}`);

  const codingAgentPackage = JSON.parse(extractAsarFile(asarPath, `${codingAgentRoot}/package.json`).toString("utf8"));
  if (codingAgentPackage.version !== expectedPiVersion) {
    throw new Error(
      `Packaged Pi version ${codingAgentPackage.version ?? "unknown"} does not match ${expectedPiVersion}`,
    );
  }

  for (const [packageRoot, lockRoot = packageRoot] of [
    [codingAgentRoot],
    ["node_modules/@earendil-works/pi-ai"],
    ["node_modules/@earendil-works/pi-telemetry"],
    ["node_modules/@earendil-works/pi-agent-core", `${nested}/@earendil-works/pi-agent-core`],
    [`${nested}/@earendil-works/pi-ai`],
    [`${nested}/@earendil-works/pi-client`],
    [`${nested}/@earendil-works/pi-protocol`],
    [`${nested}/@earendil-works/pi-telemetry`],
    [`${nested}/@earendil-works/pi-tui`],
    ["node_modules/grok-mermaid", `${nested}/grok-mermaid`],
  ]) {
    const packaged = JSON.parse(extractAsarFile(asarPath, `${packageRoot}/package.json`).toString("utf8"));
    const locked = lockfile.packages?.[lockRoot]?.version;
    if (!locked || packaged.version !== locked) {
      throw new Error(
        `Packaged ${packaged.name ?? packageRoot} version ${packaged.version ?? "unknown"} does not match lockfile ${locked ?? "missing"}`,
      );
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAsarFile(archive, entry) {
  return extractFile(archive, path.join(...entry.split("/")));
}

function verifyBundledTools(resources, platform, arch, executeTools) {
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
    if (platform === "darwin") {
      if (!/^[a-f0-9]{64}$/.test(tool.darwinCodeSha256) || !Number.isSafeInteger(tool.darwinCodeBytes)) {
        throw new Error(`Missing signed-code integrity metadata: ${executable}`);
      }
      verifyDarwinExecutable(executable, tool.darwinCodeSha256, tool.darwinCodeBytes);
    } else {
      verifyManifestFile(executable, tool.sha256, tool.bytes);
    }
    if (platform !== "win32" && (fs.statSync(executable).mode & 0o111) === 0) {
      throw new Error(`${tool.componentId} is not executable`);
    }
    byComponent.set(tool.componentId, executable);
  }
  for (const license of manifest.licenses) {
    if (!safeRelativePath(license.path)) throw new Error("Unsafe core license manifest entry");
    verifyManifestFile(path.join(targetRoot, license.path), license.sha256);
  }

  if (!executeTools) return;

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

function runPackagedStartup(executable, toolTarget, environmentPatch = {}, extraArguments = []) {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "pi-packaged-startup-"));
  const userData = path.join(isolated, "user-data");
  const environment = {
    ...process.env,
    HOME: isolated,
    USERPROFILE: isolated,
    APPDATA: path.join(isolated, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolated, "AppData", "Local"),
    TMPDIR: isolated,
    XDG_CONFIG_HOME: path.join(isolated, ".config"),
    XDG_CACHE_HOME: path.join(isolated, ".cache"),
    XDG_DATA_HOME: path.join(isolated, ".local", "share"),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    ...environmentPatch,
  };
  try {
    const result = spawnSync(
      executable,
      [...extraArguments, `--user-data-dir=${userData}`, "--validate-packaged-startup", "--disable-gpu"],
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
      throw new Error(
        `Packaged startup exited ${result.status}: ${[result.stdout, result.stderr].filter(Boolean).join("\n").slice(-4_000)}`,
      );
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
      report.piVersion !== expectedPiVersion ||
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

function verifyDarwinExecutable(file, expectedSha256, expectedBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Manifest target is not a regular file: ${file}`);
  const digest = darwinCodeDigest(fs.readFileSync(file), expectedBytes);
  if (!digest || digest.bytes !== expectedBytes || digest.sha256 !== expectedSha256) {
    throw new Error(`Signed Mach-O code mismatch: ${file}`);
  }
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
