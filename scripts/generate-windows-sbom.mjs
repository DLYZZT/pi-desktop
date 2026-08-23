#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crossToolchain } from "./build-windows-managed-helper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = { os: "win32", cpu: "x64", triple: "x86_64-pc-windows-msvc" };
const knownSpdxIds = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "GPL-3.0-or-later",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

function fail(message) {
  throw new Error(`[windows-sbom] ${message}`);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function allowedForTarget(rules, value) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const positive = rules.filter((entry) => !entry.startsWith("!"));
  if (rules.includes(`!${value}`)) return false;
  return positive.length === 0 || positive.includes(value);
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) fail(`invalid package-lock path: ${lockPath}`);
  const parts = lockPath.slice(index + marker.length).split("/");
  const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || (name.startsWith("@") && !name.includes("/"))) fail(`invalid package name at ${lockPath}`);
  return name;
}

function parentLockPath(lockPath) {
  const index = lockPath.lastIndexOf("/node_modules/");
  return index < 0 ? "" : lockPath.slice(0, index);
}

function resolveLockDependency(packages, fromPath, dependencyName) {
  let current = fromPath;
  for (;;) {
    const candidate = current ? `${current}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!current) return null;
    current = parentLockPath(current);
  }
}

function npmPurl(name, version) {
  const encodedName = encodeURIComponent(name).replaceAll("%2F", "/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity) {
  if (typeof integrity !== "string") return undefined;
  const separator = integrity.indexOf("-");
  if (separator < 1) return undefined;
  const algorithm = integrity.slice(0, separator).toLowerCase();
  const cycloneAlgorithm = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[algorithm];
  if (!cycloneAlgorithm) return undefined;
  try {
    const content = Buffer.from(integrity.slice(separator + 1), "base64");
    if (content.length === 0) return undefined;
    return { alg: cycloneAlgorithm, content: content.toString("hex") };
  } catch {
    return undefined;
  }
}

function licenses(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.trim().replaceAll("apache-2.0", "Apache-2.0");
  if (knownSpdxIds.has(normalized)) return [{ license: { id: normalized } }];
  const tokens = normalized.match(/[A-Za-z0-9.-]+/gu) ?? [];
  if (
    /\b(?:AND|OR)\b/u.test(normalized) &&
    tokens.filter((token) => token !== "AND" && token !== "OR").every((token) => knownSpdxIds.has(token))
  ) {
    return [{ expression: normalized }];
  }
  return [{ license: { name: normalized } }];
}

function npmRef(lockPath) {
  return `urn:pi:npm:${sha256(lockPath).slice(0, 24)}`;
}

function productionNpmGraph(packageLock) {
  if (
    packageLock?.lockfileVersion !== 3 ||
    !exactKeys(packageLock.packages?.[""], ["name", "version", "license", "dependencies", "devDependencies", "engines"])
  ) {
    fail("package-lock.json must remain lockfile v3 with the expected root package contract");
  }
  const packages = packageLock.packages;
  const selected = new Map(
    Object.entries(packages).filter(
      ([lockPath, entry]) =>
        lockPath &&
        entry.dev !== true &&
        allowedForTarget(entry.os, target.os) &&
        allowedForTarget(entry.cpu, target.cpu),
    ),
  );
  const components = [];
  const dependencies = [];
  for (const [lockPath, entry] of selected) {
    const name = packageNameFromLockPath(lockPath);
    if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(entry.version)) {
      fail(`${lockPath} has no exact semantic version`);
    }
    const component = {
      type: "library",
      "bom-ref": npmRef(lockPath),
      name,
      version: entry.version,
      scope: entry.optional === true ? "optional" : "required",
      purl: npmPurl(name, entry.version),
      properties: [
        { name: "pi:package-lock:path", value: lockPath },
        ...(entry.integrity ? [{ name: "pi:package-lock:integrity", value: entry.integrity }] : []),
        ...(entry.peer === true ? [{ name: "pi:npm:peer", value: "true" }] : []),
      ],
    };
    const hash = integrityHash(entry.integrity);
    if (hash) component.hashes = [hash];
    const componentLicenses = licenses(entry.license);
    if (componentLicenses) component.licenses = componentLicenses;
    if (typeof entry.resolved === "string" && /^https:\/\//u.test(entry.resolved)) {
      component.externalReferences = [{ type: "distribution", url: entry.resolved }];
    }
    components.push(component);

    const dependencyNames = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    const dependsOn = [];
    for (const dependencyName of dependencyNames) {
      const resolved = resolveLockDependency(packages, lockPath, dependencyName);
      if (!resolved) {
        if (Object.hasOwn(entry.dependencies ?? {}, dependencyName)) {
          fail(`${lockPath} cannot resolve production dependency ${dependencyName}`);
        }
        continue;
      }
      if (selected.has(resolved)) dependsOn.push(npmRef(resolved));
      else if (Object.hasOwn(entry.dependencies ?? {}, dependencyName)) {
        fail(`${lockPath} resolves production dependency ${dependencyName} outside the Windows production graph`);
      }
    }
    dependencies.push({ ref: npmRef(lockPath), dependsOn: [...new Set(dependsOn)].sort() });
  }

  const rootDependencies = [];
  for (const dependencyName of Object.keys(packages[""].dependencies)) {
    const resolved = resolveLockDependency(packages, "", dependencyName);
    if (!resolved || !selected.has(resolved))
      fail(`root dependency ${dependencyName} is absent from the production graph`);
    rootDependencies.push(npmRef(resolved));
  }
  return {
    components: components.sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"], "en-US")),
    dependencies: dependencies.sort((left, right) => left.ref.localeCompare(right.ref, "en-US")),
    rootDependencies: rootDependencies.sort(),
  };
}

function cargoPackages(cargoLock) {
  const result = new Map();
  for (const block of cargoLock.split("[[package]]").slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/mu)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/mu)?.[1];
    const checksum = block.match(/^\s*checksum\s*=\s*"([a-f0-9]{64})"/mu)?.[1];
    if (name && version) result.set(name, { version, checksum });
  }
  return result;
}

function component(definition) {
  const result = {
    type: definition.type ?? "library",
    "bom-ref": definition.ref,
    name: definition.name,
    version: definition.version,
    scope: definition.scope ?? "required",
    ...(definition.purl ? { purl: definition.purl } : {}),
    ...(definition.license ? { licenses: licenses(definition.license) } : {}),
    ...(definition.hash ? { hashes: [{ alg: "SHA-256", content: definition.hash }] } : {}),
    ...(definition.properties?.length ? { properties: definition.properties } : {}),
  };
  return result;
}

function buildTool(ref, name, version, role, properties = []) {
  return component({
    type: "application",
    ref,
    name,
    version,
    scope: "excluded",
    properties: [{ name: "pi:build:role", value: role }, ...properties],
  });
}

export function createWindowsSbom(facts) {
  const npm = productionNpmGraph(facts.packageLock);
  const cargo = cargoPackages(facts.cargoLock);
  const windowsSys = cargo.get("windows-sys");
  const windowsLink = cargo.get("windows-link");
  if (windowsSys?.version !== "0.61.2" || windowsLink?.version !== "0.2.1") {
    fail("the helper Cargo.lock runtime allowlist drifted");
  }
  if (
    !exactKeys(facts.helperManifest, [
      "schemaVersion",
      "protocolVersion",
      "buildId",
      "arch",
      "provenance",
      "file",
      "sha256",
      "sourceRevision",
      "targetTriple",
    ]) ||
    facts.helperManifest.schemaVersion !== 1 ||
    facts.helperManifest.protocolVersion !== 1 ||
    facts.helperManifest.arch !== "x64" ||
    facts.helperManifest.provenance !== "release-authoritative" ||
    facts.helperManifest.targetTriple !== target.triple ||
    facts.helperManifest.sha256 !== facts.helperHash
  ) {
    fail("release-authoritative helper manifest does not match the helper bytes");
  }
  if (facts.electronVersions.electron !== facts.electronPackage.version)
    fail("Electron runtime and lock version differ");
  if (facts.rustToolchain !== "1.96.1") fail("Rust toolchain drifted from 1.96.1");
  if (facts.provenance.rustc !== facts.rustToolchain || facts.provenance.cargo !== facts.rustToolchain) {
    fail("native rustc/Cargo do not match rust-toolchain.toml");
  }

  const coreById = new Map(facts.coreManifest.tools.map((tool) => [tool.componentId, tool]));
  const ripgrep = coreById.get("ripgrep");
  const fd = coreById.get("fd");
  if (
    facts.coreManifest.schemaVersion !== 1 ||
    facts.coreManifest.platform !== "win32" ||
    facts.coreManifest.arch !== "x64" ||
    facts.coreManifest.tools.length !== 2 ||
    ripgrep?.version !== "15.2.0" ||
    fd?.version !== "10.3.0"
  ) {
    fail("bundled Windows core tool manifest drifted");
  }

  const manualComponents = [
    component({
      type: "framework",
      ref: "runtime:electron",
      name: "Electron",
      version: facts.electronVersions.electron,
      purl: `pkg:npm/electron@${facts.electronVersions.electron}`,
      license: "MIT",
    }),
    component({
      type: "framework",
      ref: "runtime:chromium",
      name: "Chromium",
      version: facts.electronVersions.chrome,
      purl: `pkg:generic/chromium@${facts.electronVersions.chrome}`,
      license: "BSD-3-Clause",
    }),
    component({
      ref: "runtime:node",
      name: "Node.js (Electron embedded)",
      version: facts.electronVersions.node,
      purl: `pkg:generic/nodejs@${facts.electronVersions.node}`,
      license: "MIT",
    }),
    component({
      ref: "runtime:v8",
      name: "V8",
      version: facts.electronVersions.v8,
      purl: `pkg:generic/v8@${encodeURIComponent(facts.electronVersions.v8)}`,
      license: "BSD-3-Clause",
    }),
    component({
      type: "application",
      ref: "native:managed-process-helper",
      name: "pi-windows-managed-process-helper",
      version: facts.helperPackageVersion,
      purl: `pkg:cargo/pi-windows-managed-process-helper@${facts.helperPackageVersion}`,
      license: "Apache-2.0",
      hash: facts.helperHash,
      properties: [
        { name: "pi:helper:build-id", value: facts.helperManifest.buildId },
        { name: "pi:helper:protocol-version", value: String(facts.helperManifest.protocolVersion) },
        { name: "pi:helper:provenance", value: facts.helperManifest.provenance },
        { name: "pi:helper:source-revision", value: facts.helperManifest.sourceRevision },
        { name: "pi:helper:target", value: facts.helperManifest.targetTriple },
      ],
    }),
    component({
      ref: "native:rust-std",
      name: "Rust standard library",
      version: facts.rustToolchain,
      purl: `pkg:generic/rust-std@${facts.rustToolchain}?target=${target.triple}`,
      license: "Apache-2.0 OR MIT",
      properties: [{ name: "pi:linkage", value: "static" }],
    }),
    component({
      ref: "native:windows-sys",
      name: "windows-sys",
      version: windowsSys.version,
      purl: `pkg:cargo/windows-sys@${windowsSys.version}`,
      license: "Apache-2.0 OR MIT",
      hash: windowsSys.checksum,
      properties: [{ name: "pi:linkage", value: "static" }],
    }),
    component({
      ref: "native:windows-link",
      name: "windows-link",
      version: windowsLink.version,
      purl: `pkg:cargo/windows-link@${windowsLink.version}`,
      license: "Apache-2.0 OR MIT",
      hash: windowsLink.checksum,
      properties: [{ name: "pi:linkage", value: "static" }],
    }),
    component({
      ref: "native:msvc-crt",
      name: "Microsoft Visual C++ runtime",
      version: facts.provenance.nativeMsvcToolset,
      license: "Microsoft Software License Terms",
      properties: [
        { name: "pi:linkage", value: "static" },
        { name: "pi:build:role", value: "authoritative-native-helper-runtime" },
      ],
    }),
    ...[ripgrep, fd].map((tool) =>
      component({
        type: "application",
        ref: `bundled:${tool.componentId}`,
        name: tool.componentId,
        version: tool.version,
        purl:
          tool.componentId === "ripgrep"
            ? `pkg:github/BurntSushi/ripgrep@${tool.version}`
            : `pkg:github/sharkdp/fd@${tool.version}`,
        license: tool.componentId === "ripgrep" ? "MIT OR Unlicense" : "Apache-2.0 OR MIT",
        hash: tool.sha256,
        properties: [
          { name: "pi:bundled:artifact-sha256", value: tool.artifactSha256 },
          { name: "pi:bundled:bytes", value: String(tool.bytes) },
        ],
      }),
    ),
  ];

  const buildTools = [
    buildTool("tool:rustc", "rustc", facts.provenance.rustc, "authoritative-native-compiler", [
      { name: "pi:build:commit", value: facts.provenance.rustcCommit },
      { name: "pi:build:target", value: target.triple },
    ]),
    buildTool("tool:cargo", "Cargo", facts.provenance.cargo, "authoritative-native-build-driver", [
      { name: "pi:build:commit", value: facts.provenance.cargoCommit },
    ]),
    buildTool(
      "tool:rustc-llvm",
      "LLVM (rustc backend)",
      facts.provenance.rustcLlvm,
      "authoritative-native-compiler-backend",
    ),
    buildTool(
      "tool:windows-sdk-native",
      "Windows SDK",
      facts.provenance.nativeWindowsSdk,
      "authoritative-native-resource-compiler",
    ),
    buildTool(
      "tool:msvc-native",
      "MSVC toolset",
      facts.provenance.nativeMsvcToolset,
      "authoritative-native-linker-and-crt",
    ),
    buildTool("tool:cargo-xwin", "cargo-xwin", crossToolchain.cargoXwin, "cross-build-compile-gate", [
      { name: "pi:build:authoritative-release-source", value: "false" },
    ]),
    buildTool("tool:llvm-cross", "LLVM", crossToolchain.llvmMajor, "cross-build-resource-compiler", [
      { name: "pi:build:authoritative-release-source", value: "false" },
    ]),
    buildTool("tool:windows-sdk-cross", "Windows SDK", crossToolchain.sdk, "cargo-xwin-fixed-sysroot", [
      { name: "pi:build:authoritative-release-source", value: "false" },
    ]),
    buildTool("tool:msvc-crt-cross", "MSVC CRT manifest package", crossToolchain.crt, "cargo-xwin-fixed-sysroot", [
      { name: "pi:build:authoritative-release-source", value: "false" },
    ]),
  ];

  const rootRef = "application:pi-agent-desktop-windows-x64";
  const dependencies = [
    ...npm.dependencies,
    {
      ref: rootRef,
      dependsOn: [
        ...npm.rootDependencies,
        "runtime:electron",
        "native:managed-process-helper",
        "bundled:ripgrep",
        "bundled:fd",
      ].sort(),
    },
    { ref: "runtime:electron", dependsOn: ["runtime:chromium", "runtime:node", "runtime:v8"] },
    {
      ref: "native:managed-process-helper",
      dependsOn: ["native:rust-std", "native:windows-sys", "native:msvc-crt"],
    },
    { ref: "native:windows-sys", dependsOn: ["native:windows-link"] },
    ...manualComponents
      .filter(
        (entry) =>
          !["runtime:electron", "native:managed-process-helper", "native:windows-sys"].includes(entry["bom-ref"]),
      )
      .map((entry) => ({ ref: entry["bom-ref"], dependsOn: [] })),
  ].sort((left, right) => left.ref.localeCompare(right.ref, "en-US"));

  return {
    $schema: "https://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      tools: { components: buildTools },
      component: {
        type: "application",
        "bom-ref": rootRef,
        group: facts.packageJson.name.split("/")[0],
        name: facts.packageJson.name.split("/").at(-1),
        version: facts.packageJson.version,
        licenses: licenses(facts.packageJson.license),
        hashes: [{ alg: "SHA-256", content: facts.installerHash }],
        purl: `pkg:github/DLYZZT/pi-desktop@${facts.packageJson.version}?arch=x86_64&os=windows`,
        properties: [
          { name: "pi:artifact:file", value: facts.installerName },
          { name: "pi:artifact:sha256", value: facts.installerHash },
          { name: "pi:source:package-lock-sha256", value: facts.packageLockHash },
          { name: "pi:source:third-party-notices-sha256", value: facts.noticesHash },
          { name: "pi:target", value: target.triple },
        ],
      },
      properties: [
        { name: "pi:sbom:dependency-source", value: "package-lock.json lockfileVersion 3 production graph" },
        { name: "pi:sbom:platform", value: "win32-x64" },
      ],
    },
    components: [...npm.components, ...manualComponents].sort((left, right) =>
      left["bom-ref"].localeCompare(right["bom-ref"], "en-US"),
    ),
    dependencies,
  };
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function parseVersion(output, label) {
  const version = output.match(/^release:\s*(\d+\.\d+\.\d+)$/mu)?.[1];
  const commit = output.match(/^commit-hash:\s*([a-f0-9]{40})$/mu)?.[1];
  if (!version || !commit) fail(`cannot parse ${label} verbose version`);
  return { version, commit };
}

function nativeWindowsSdkVersion(projectRoot) {
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
  const version = compiler?.split(path.sep).find((part) => /^\d+(?:\.\d+){3}$/u.test(part));
  if (!compiler || !version) fail(`cannot identify the native Windows SDK used under ${projectRoot}`);
  return version;
}

function nativeMsvcToolsetVersion() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!fs.existsSync(vswhere)) fail("vswhere.exe is required to identify the native MSVC toolset");
  const installation = runCapture(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  const versionFile = path.join(installation, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const version = fs.readFileSync(versionFile, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) fail("native MSVC toolset version is malformed");
  return version;
}

function electronRuntimeVersions(projectRoot) {
  const executable = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
  const output = runCapture(executable, ["-p", "JSON.stringify(process.versions)"], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const versions = JSON.parse(output);
  for (const key of ["electron", "chrome", "node", "v8"]) {
    if (typeof versions[key] !== "string" || versions[key] === "") fail(`Electron process.versions.${key} is absent`);
  }
  return versions;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function windowsSbomFile(projectRoot = root) {
  const packageJson = readJson(path.join(projectRoot, "package.json"));
  return path.join(projectRoot, "dist", `Pi-Agent-Desktop-Windows-x64-${packageJson.version}.cdx.json`);
}

export function collectWindowsSbomFacts(projectRoot = root) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("Windows x64 is required");
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageLockPath = path.join(projectRoot, "package-lock.json");
  const helperRoot = path.join(projectRoot, "out", "native", "windows-managed-process-helper");
  const helperManifest = readJson(path.join(helperRoot, "manifest.json"));
  const helperBytes = fs.readFileSync(path.join(helperRoot, helperManifest.file));
  const packageJson = readJson(packageJsonPath);
  const installerName = `Pi-Agent-Desktop-Unsigned-Beta-Setup-${packageJson.version}.exe`;
  const installer = path.join(projectRoot, "dist", installerName);
  if (!fs.statSync(installer).isFile() || fs.statSync(installer).size === 0)
    fail(`installer is missing: ${installerName}`);
  const rustToolchainSource = fs.readFileSync(
    path.join(projectRoot, "native", "windows-managed-process-helper", "rust-toolchain.toml"),
    "utf8",
  );
  const rustToolchain = rustToolchainSource.match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"$/mu)?.[1];
  if (!rustToolchain) fail("cannot parse rust-toolchain.toml");
  const rustcOutput = runCapture("rustc", ["-Vv"], { cwd: projectRoot });
  const cargoOutput = runCapture("cargo", ["-Vv"], { cwd: projectRoot });
  const rustc = parseVersion(rustcOutput, "rustc");
  const cargo = parseVersion(cargoOutput, "Cargo");
  const rustcLlvm = rustcOutput.match(/^LLVM version:\s*(\S+)$/mu)?.[1];
  if (!rustcLlvm) fail("cannot parse rustc LLVM version");
  const electronPackage = readJson(path.join(projectRoot, "node_modules", "electron", "package.json"));
  const cargoToml = fs.readFileSync(
    path.join(projectRoot, "native", "windows-managed-process-helper", "Cargo.toml"),
    "utf8",
  );
  const helperPackageVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"$/mu)?.[1];
  if (!helperPackageVersion) fail("cannot parse helper Cargo.toml package version");
  const packageLockSource = fs.readFileSync(packageLockPath);
  return {
    packageJson,
    packageLock: JSON.parse(packageLockSource.toString("utf8")),
    packageLockHash: sha256(packageLockSource),
    cargoLock: fs.readFileSync(
      path.join(projectRoot, "native", "windows-managed-process-helper", "Cargo.lock"),
      "utf8",
    ),
    helperManifest,
    helperHash: sha256(helperBytes),
    helperPackageVersion,
    coreManifest: readJson(
      path.join(projectRoot, "build", "toolchains", "core", "win32-x64", "manifests", "core-tools.json"),
    ),
    electronPackage,
    electronVersions: electronRuntimeVersions(projectRoot),
    rustToolchain,
    provenance: {
      rustc: rustc.version,
      rustcCommit: rustc.commit,
      cargo: cargo.version,
      cargoCommit: cargo.commit,
      rustcLlvm,
      nativeWindowsSdk: nativeWindowsSdkVersion(projectRoot),
      nativeMsvcToolset: nativeMsvcToolsetVersion(),
    },
    installerName,
    installerHash: sha256(fs.readFileSync(installer)),
    noticesHash: sha256(fs.readFileSync(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"))),
  };
}

export function generateWindowsSbom(projectRoot = root) {
  const file = windowsSbomFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sbom = createWindowsSbom(collectWindowsSbomFacts(projectRoot));
  fs.writeFileSync(file, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  console.log(`[windows-sbom] generated ${path.basename(file)} with ${sbom.components.length} components`);
  return file;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    if (process.argv.length !== 2) fail("no arguments are supported");
    generateWindowsSbom();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
