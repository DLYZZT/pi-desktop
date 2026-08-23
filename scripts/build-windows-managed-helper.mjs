#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyWindowsHelperPe } from "./windows-helper-pe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetTriple = "x86_64-pc-windows-msvc";
const executableName = "pi-managed-process-helper.exe";
const protocolVersion = 1;
export const crossToolchain = {
  cargoXwin: "0.23.1",
  llvmMajor: "18",
  xwin: "17",
  sdk: "10.0.26100",
  crt: "14.44.17.14",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: options.encoding,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw new Error(`${options.label ?? command} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`${options.label ?? command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${options.label ?? command} exited with status ${result.status}`);
  return result;
}

function sourceRevision(projectRoot) {
  const crateRoot = path.join(projectRoot, "native", "windows-managed-process-helper");
  const inputs = [
    path.join(projectRoot, "scripts", "build-windows-managed-helper.mjs"),
    path.join(crateRoot, ".cargo", "config.toml"),
    path.join(crateRoot, "build.rs"),
    path.join(crateRoot, "Cargo.lock"),
    path.join(crateRoot, "Cargo.toml"),
    path.join(crateRoot, "deny.toml"),
    path.join(crateRoot, "rust-toolchain.toml"),
    ...["resources", "src"].flatMap((directory) => {
      const root = path.join(crateRoot, directory);
      const files = [];
      const visit = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const candidate = path.join(current, entry.name);
          if (entry.isDirectory()) visit(candidate);
          else if (entry.isFile()) files.push(candidate);
        }
      };
      visit(root);
      return files;
    }),
  ].sort((left, right) => left.localeCompare(right, "en-US"));
  const digest = createHash("sha256");
  digest.update(JSON.stringify({ schema: 1, protocolVersion, targetTriple, crossToolchain }), "utf8");
  for (const input of inputs) {
    const relative = path.relative(projectRoot, input).replaceAll(path.sep, "/");
    const normalized = fs.readFileSync(input, "utf8").replace(/\r\n/gu, "\n");
    digest.update("\0", "utf8");
    digest.update(relative, "utf8");
    digest.update("\0", "utf8");
    digest.update(normalized, "utf8");
  }
  return digest.digest("hex").slice(0, 12);
}

function findWindowsResourceCompiler() {
  const candidates = [];
  const configuredBin = process.env.WindowsSdkVerBinPath;
  if (configuredBin) candidates.push(path.join(configuredBin, "x64", "rc.exe"));
  const sdkRoot = process.env.WindowsSdkDir;
  const sdkVersion = process.env.WindowsSDKVersion?.replace(/[\\/]+$/u, "");
  if (sdkRoot && sdkVersion) candidates.push(path.join(sdkRoot, "bin", sdkVersion, "x64", "rc.exe"));
  const kitsBin = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (fs.existsSync(kitsBin)) {
    const versions = fs
      .readdirSync(kitsBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+){3}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "en-US", { numeric: true }));
    for (const version of versions) candidates.push(path.join(kitsBin, version, "x64", "rc.exe"));
  }
  const compiler = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new Error("A pinned Windows SDK x64 resource compiler is required");
  return compiler;
}

function findLlvmResourceCompiler() {
  const versionCandidates = [
    process.env.PIMPD_LLVM_CONFIG,
    `llvm-config-${crossToolchain.llvmMajor}`,
    "llvm-config",
  ].filter(Boolean);
  const version = versionCandidates.find((candidate) => {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return (
      !result.error && result.status === 0 && new RegExp(`^${crossToolchain.llvmMajor}\\.`, "u").test(result.stdout)
    );
  });
  if (!version) throw new Error(`LLVM ${crossToolchain.llvmMajor} llvm-config is required`);
  const candidates = [process.env.PIMPD_LLVM_RC, `llvm-rc-${crossToolchain.llvmMajor}`, "llvm-rc"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["/?"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!result.error && result.status === 0 && result.stdout.includes("Resource Converter")) return candidate;
  }
  throw new Error(`LLVM ${crossToolchain.llvmMajor} llvm-rc is required for the Windows helper cross-check`);
}

function compileVersionResource(projectRoot, packageVersion, buildId, cross = false) {
  const parts = packageVersion.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65_535)) {
    throw new Error(`Package version cannot be represented as a PE version: ${packageVersion}`);
  }
  const crateRoot = path.join(projectRoot, "native", "windows-managed-process-helper");
  const generatedRoot = path.join(crateRoot, "target", "pimpd-resource");
  fs.mkdirSync(generatedRoot, { recursive: true });
  const template = fs.readFileSync(path.join(crateRoot, "resources", "helper.rc.template"), "utf8");
  const manifestPath = path.join(crateRoot, "resources", "helper.manifest").replaceAll("\\", "/");
  const source = template
    .replaceAll("@VERSION_TUPLE@", [...parts, 0].join(","))
    .replaceAll("@VERSION_STRING@", packageVersion)
    .replaceAll("@BUILD_ID@", buildId)
    .replaceAll("@MANIFEST_PATH@", manifestPath);
  const rcFile = path.join(generatedRoot, "helper.rc");
  const resourceFile = path.join(generatedRoot, "helper.res");
  fs.writeFileSync(rcFile, source, "utf8");
  const compiler = cross ? findLlvmResourceCompiler() : findWindowsResourceCompiler();
  run(compiler, cross ? ["/FO", resourceFile, rcFile] : ["/nologo", `/fo${resourceFile}`, rcFile], {
    cwd: crateRoot,
    label: "Windows helper resource compilation",
  });
  return resourceFile;
}

function assertCargoXwinVersion() {
  const result = run("cargo", ["xwin", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    label: "cargo-xwin version check",
  });
  if (
    !new RegExp(`cargo-xwin(?:-xwin)? ${crossToolchain.cargoXwin.replaceAll(".", "\\.")}(?:\\s|$)`, "u").test(
      result.stdout,
    )
  ) {
    throw new Error(`cargo-xwin ${crossToolchain.cargoXwin} is required`);
  }
}

export function crossCheckWindowsManagedHelper({ projectRoot = root } = {}) {
  if (process.platform === "win32") throw new Error("The cargo-xwin compile-only gate must run on macOS or Linux");
  assertCargoXwinVersion();
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const revision = sourceRevision(projectRoot);
  const provenance = "cross-dev";
  const buildId = `pimpd-${packageJson.version}-p${protocolVersion}-${revision}`;
  const resourceFile = compileVersionResource(projectRoot, packageJson.version, buildId, true);
  const environment = {
    ...process.env,
    PIMPD_BUILD_ID: buildId,
    PIMPD_PROVENANCE: provenance,
    PIMPD_RESOURCE_FILE: resourceFile,
    XWIN_ARCH: "x86_64",
    XWIN_VARIANT: "desktop",
    XWIN_VERSION: crossToolchain.xwin,
    XWIN_SDK_VERSION: crossToolchain.sdk,
    XWIN_CRT_VERSION: crossToolchain.crt,
    XWIN_INCLUDE_DEBUG_LIBS: "false",
    XWIN_INCLUDE_DEBUG_SYMBOLS: "false",
  };
  run("cargo", ["xwin", "build", "--locked", "--release", "--target", targetTriple], {
    cwd: path.join(projectRoot, "native", "windows-managed-process-helper"),
    env: environment,
    label: "cargo-xwin helper compile-only gate",
  });
  const output = path.join(
    projectRoot,
    "native",
    "windows-managed-process-helper",
    "target",
    targetTriple,
    "release",
    "pi-windows-managed-process-helper.exe",
  );
  verifyWindowsHelperPe(output);
  console.log(
    `[windows-helper] cross-check built ${buildId} provenance=${provenance} cargo-xwin=${crossToolchain.cargoXwin} llvm=${crossToolchain.llvmMajor} sdk=${crossToolchain.sdk} crt=${crossToolchain.crt}`,
  );
  return { output, provenance, buildId, crossToolchain: { ...crossToolchain } };
}

export function buildWindowsManagedHelper({ projectRoot = root, release = false } = {}) {
  if (process.platform !== "win32") {
    if (release) throw new Error("Release-authoritative Windows helper builds must run on Windows");
    return crossCheckWindowsManagedHelper({ projectRoot });
  }
  if (process.arch !== "x64") throw new Error(`Unsupported Windows helper build architecture: ${process.arch}`);
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const revision = sourceRevision(projectRoot);
  const provenance = release ? "release-authoritative" : "windows-native-dev";
  const buildId = `pimpd-${packageJson.version}-p${protocolVersion}-${revision}`;
  const resourceFile = compileVersionResource(projectRoot, packageJson.version, buildId);
  const environment = {
    ...process.env,
    PIMPD_BUILD_ID: buildId,
    PIMPD_PROVENANCE: provenance,
    PIMPD_RESOURCE_FILE: resourceFile,
  };
  run("cargo", ["build", "--locked", "--release", "--target", targetTriple], {
    cwd: path.join(projectRoot, "native", "windows-managed-process-helper"),
    env: environment,
    label: "Cargo helper build",
  });
  const source = path.join(
    projectRoot,
    "native",
    "windows-managed-process-helper",
    "target",
    targetTriple,
    "release",
    "pi-windows-managed-process-helper.exe",
  );
  verifyWindowsHelperPe(source);
  const outputDirectory = path.join(projectRoot, "out", "native", "windows-managed-process-helper");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, executableName);
  fs.copyFileSync(source, output);
  const versionResult = run(output, ["--version-json-v1"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    label: "helper version check",
  });
  let version;
  try {
    version = JSON.parse(versionResult.stdout);
  } catch {
    throw new Error("Windows managed process helper returned malformed version metadata");
  }
  const expectedVersion = { protocolVersion, buildId, arch: "x64", provenance };
  if (
    !version ||
    typeof version !== "object" ||
    Object.keys(version).sort().join(",") !== Object.keys(expectedVersion).sort().join(",") ||
    Object.entries(expectedVersion).some(([key, value]) => version[key] !== value)
  ) {
    throw new Error("Windows managed process helper version metadata does not match the build");
  }
  const selfTestResult = run(output, ["--self-test-json-v1"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    label: "helper self-test",
  });
  let selfTest;
  try {
    selfTest = JSON.parse(selfTestResult.stdout);
  } catch {
    throw new Error("Windows managed process helper returned malformed self-test metadata");
  }
  if (
    selfTest?.ok !== true ||
    selfTest.protocolVersion !== protocolVersion ||
    selfTest.buildId !== buildId ||
    selfTest.arch !== "x64" ||
    !Array.isArray(selfTest.checks) ||
    !["job-dacl", "kill-on-close", "completion-port", "accounting"].every((check) => selfTest.checks.includes(check))
  ) {
    throw new Error("Windows managed process helper self-test failed");
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(output)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    protocolVersion,
    buildId,
    arch: "x64",
    provenance,
    file: executableName,
    sha256,
    sourceRevision: revision,
    targetTriple,
  };
  fs.writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[windows-helper] built ${buildId} sha256=${sha256}`);
  return { output, manifest };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.some((value) => value !== "--release")) throw new Error("Only --release is supported");
    buildWindowsManagedHelper({ release: args.includes("--release") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
