import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandDescriptor } from "../../shared/toolchains/types.ts";
import type { ToolchainPaths } from "./paths.ts";

const SHIM_MANIFEST_SCHEMA = 1;

interface ShimManifest {
  schemaVersion: typeof SHIM_MANIFEST_SCHEMA;
  platform: NodeJS.Platform;
  executable: string;
}

function shimId(executable: string, platform: NodeJS.Platform): string {
  return createHash("sha256").update(platform).update("\0").update(executable).digest("hex").slice(0, 24);
}

function windowsBatchExecutable(executable: string): string {
  return executable.replace(/%/g, "%%");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsBashExecutable(executable: string): string {
  return executable.replace(/\\/g, "/");
}

function expectedWindowsBashShim(executable: string): string {
  return `#!/usr/bin/env bash\nexec ${shellQuote(windowsBashExecutable(executable))} "$@"\n`;
}

function expectedWindowsBatchShim(executable: string): string {
  return `@echo off\r\n"${windowsBatchExecutable(executable)}" %*\r\n`;
}

function manifestPath(directory: string): string {
  return path.join(directory, "shim-manifest.json");
}

function validExistingShim(directory: string, executable: string, platform: NodeJS.Platform): boolean {
  try {
    const raw = fs.readFileSync(manifestPath(directory), "utf8");
    if (Buffer.byteLength(raw) > 16 * 1024) return false;
    const manifest = JSON.parse(raw) as ShimManifest;
    if (
      manifest.schemaVersion !== SHIM_MANIFEST_SCHEMA ||
      manifest.platform !== platform ||
      manifest.executable !== executable
    ) {
      return false;
    }
    if (platform === "win32") {
      for (const name of ["python", "python3"]) {
        if (fs.readFileSync(path.join(directory, name), "utf8") !== expectedWindowsBashShim(executable)) return false;
        if (fs.readFileSync(path.join(directory, `${name}.cmd`), "utf8") !== expectedWindowsBatchShim(executable)) {
          return false;
        }
      }
      return true;
    }
    return ["python", "python3"].every((name) => {
      const link = path.join(directory, name);
      return fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === executable;
    });
  } catch {
    return false;
  }
}

function writeShim(directory: string, executable: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    for (const name of ["python", "python3"]) {
      fs.writeFileSync(path.join(directory, name), expectedWindowsBashShim(executable), { mode: 0o700 });
      fs.writeFileSync(path.join(directory, `${name}.cmd`), expectedWindowsBatchShim(executable), { mode: 0o600 });
    }
  } else {
    fs.symlinkSync(executable, path.join(directory, "python"));
    fs.symlinkSync(executable, path.join(directory, "python3"));
  }
  const manifest: ShimManifest = { schemaVersion: SHIM_MANIFEST_SCHEMA, platform, executable };
  fs.writeFileSync(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function ensurePythonShims(options: {
  paths: ToolchainPaths;
  descriptor: CommandDescriptor;
  platform: NodeJS.Platform;
}): string {
  const executable = options.descriptor.executable;
  const executablePathApi = options.platform === "win32" ? path.win32 : path.posix;
  if (!executablePathApi.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw new Error("Invalid Python executable path");
  }
  fs.mkdirSync(options.paths.shims, { recursive: true, mode: 0o700 });
  const directory = path.join(options.paths.shims, `python-${shimId(executable, options.platform)}`);
  if (validExistingShim(directory, executable, options.platform)) return directory;

  const staging = fs.mkdtempSync(path.join(options.paths.shims, ".python-shim-"));
  let stale: string | undefined;
  try {
    fs.chmodSync(staging, 0o700);
    writeShim(staging, executable, options.platform);
    if (fs.existsSync(directory)) {
      stale = `${directory}.stale-${randomUUID()}`;
      fs.renameSync(directory, stale);
    }
    fs.renameSync(staging, directory);
    if (stale) fs.rmSync(stale, { recursive: true, force: true });
    return directory;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (stale && fs.existsSync(stale) && !fs.existsSync(directory)) fs.renameSync(stale, directory);
    throw error;
  }
}
