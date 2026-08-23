import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WindowsManagedProcessHelperDescriptor {
  path: string;
  protocolVersion: 1;
  buildId: string;
  arch: "x64";
  provenance: "windows-native-dev" | "release-authoritative";
  sha256: string;
}

export type WindowsManagedProcessHelperResolution =
  | { ok: true; descriptor: WindowsManagedProcessHelperDescriptor }
  | { ok: false; errorCode: "HELPER_MISSING" | "HELPER_INTEGRITY" };

type HelperManifest = {
  schemaVersion: 1;
  protocolVersion: 1;
  buildId: string;
  arch: "x64";
  provenance: "windows-native-dev" | "release-authoritative";
  file: "pi-managed-process-helper.exe";
  sha256: string;
  sourceRevision: string;
  targetTriple: "x86_64-pc-windows-msvc";
};

const MANIFEST_KEYS = [
  "arch",
  "buildId",
  "file",
  "protocolVersion",
  "provenance",
  "schemaVersion",
  "sha256",
  "sourceRevision",
  "targetTriple",
] as const;

function validManifest(value: unknown): value is HelperManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return (
    Object.keys(manifest).sort().join("\0") === [...MANIFEST_KEYS].sort().join("\0") &&
    manifest.schemaVersion === 1 &&
    manifest.protocolVersion === 1 &&
    typeof manifest.buildId === "string" &&
    /^pimpd-0\.\d+\.\d+-p1-[a-f0-9]{7,12}$/u.test(manifest.buildId) &&
    manifest.arch === "x64" &&
    (manifest.provenance === "windows-native-dev" || manifest.provenance === "release-authoritative") &&
    manifest.file === "pi-managed-process-helper.exe" &&
    typeof manifest.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(manifest.sha256) &&
    typeof manifest.sourceRevision === "string" &&
    /^[a-f0-9]{7,12}$/u.test(manifest.sourceRevision) &&
    manifest.targetTriple === "x86_64-pc-windows-msvc"
  );
}

function containedFile(directory: string, file: string): string | null {
  let directoryReal: string;
  let fileReal: string;
  try {
    directoryReal = fs.realpathSync.native(directory);
    fileReal = fs.realpathSync.native(path.join(directory, file));
    const stat = fs.lstatSync(fileReal);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const relative = path.relative(directoryReal.toLocaleLowerCase("en-US"), fileReal.toLocaleLowerCase("en-US"));
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? fileReal
    : null;
}

function versionMatches(executable: string, manifest: HelperManifest): boolean {
  const result = spawnSync(executable, ["--version-json-v1"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.signal || result.error) return false;
  try {
    const version = JSON.parse(result.stdout) as Record<string, unknown>;
    return (
      Object.keys(version).sort().join("\0") === "arch\0buildId\0protocolVersion\0provenance" &&
      version.protocolVersion === manifest.protocolVersion &&
      version.buildId === manifest.buildId &&
      version.arch === manifest.arch &&
      version.provenance === manifest.provenance
    );
  } catch {
    return false;
  }
}

export function resolveWindowsManagedProcessHelper(options: {
  isPackaged: boolean;
  resourcesPath: string;
  projectRoot: string;
  verifyExecutable?: boolean;
}): WindowsManagedProcessHelperResolution {
  const directory = options.isPackaged
    ? path.join(options.resourcesPath, "managed-process", "win32-x64")
    : path.join(options.projectRoot, "out", "native", "windows-managed-process-helper");
  let manifest: unknown;
  try {
    const manifestPath = containedFile(directory, "manifest.json");
    if (!manifestPath) return { ok: false, errorCode: "HELPER_MISSING" };
    const stat = fs.statSync(manifestPath);
    if (stat.size <= 0 || stat.size > 16 * 1024) return { ok: false, errorCode: "HELPER_INTEGRITY" };
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, errorCode: "HELPER_MISSING" };
  }
  if (!validManifest(manifest)) return { ok: false, errorCode: "HELPER_INTEGRITY" };
  const executable = containedFile(directory, manifest.file);
  if (!executable) return { ok: false, errorCode: "HELPER_MISSING" };
  const actualHash = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  if (actualHash !== manifest.sha256) return { ok: false, errorCode: "HELPER_INTEGRITY" };
  if (options.verifyExecutable !== false && !versionMatches(executable, manifest)) {
    return { ok: false, errorCode: "HELPER_INTEGRITY" };
  }
  return {
    ok: true,
    descriptor: {
      path: executable,
      protocolVersion: manifest.protocolVersion,
      buildId: manifest.buildId,
      arch: manifest.arch,
      provenance: manifest.provenance,
      sha256: manifest.sha256,
    },
  };
}

export function verifyWindowsManagedProcessHelperReplaceable(
  descriptor: WindowsManagedProcessHelperDescriptor,
  rename: (source: string, destination: string) => void = fs.renameSync,
): boolean {
  if (!path.isAbsolute(descriptor.path) || path.basename(descriptor.path) !== "pi-managed-process-helper.exe") {
    return false;
  }
  const probe = path.join(
    path.dirname(descriptor.path),
    `.pi-managed-process-helper.replaceability-${process.pid}-${randomUUID()}.tmp`,
  );
  if (fs.existsSync(probe)) return false;
  let moved = false;
  try {
    rename(descriptor.path, probe);
    moved = true;
    rename(probe, descriptor.path);
    moved = false;
    return true;
  } catch {
    return false;
  } finally {
    if (moved) {
      try {
        fs.renameSync(probe, descriptor.path);
      } catch {
        // The caller will fail closed; a subsequent integrity check reports the failed restoration.
      }
    }
  }
}
