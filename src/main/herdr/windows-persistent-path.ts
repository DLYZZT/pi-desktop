import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REGISTRY_PATH_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
] as const;
const ALLOWED_EXPANSIONS = new Set([
  "systemroot",
  "windir",
  "userprofile",
  "appdata",
  "localappdata",
  "programdata",
  "programfiles",
  "programfiles(x86)",
]);
const MAX_REGISTRY_PATH_BYTES = 16 * 1024;
const MAX_PATH_ENTRY_LENGTH = 4_096;
const MAX_PATH_ENTRIES = 256;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function parseWindowsRegistryPath(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/iu);
    if (match) return match[1].trim();
  }
  return undefined;
}

export function expandWindowsPathEntry(entry: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!entry || entry.length > MAX_PATH_ENTRY_LENGTH || /[\0\r\n]/u.test(entry)) return undefined;
  let invalid = false;
  const expanded = entry.replace(/%([^%]+)%/gu, (_, variable: string) => {
    if (!ALLOWED_EXPANSIONS.has(variable.toLowerCase())) {
      invalid = true;
      return "";
    }
    const value = envValue(env, variable);
    if (!value || value.includes("%") || /[\0\r\n]/u.test(value)) {
      invalid = true;
      return "";
    }
    return value;
  });
  if (
    invalid ||
    expanded.includes("%") ||
    expanded.length > MAX_PATH_ENTRY_LENGTH ||
    !path.win32.isAbsolute(expanded)
  ) {
    return undefined;
  }
  return path.win32.normalize(expanded);
}

async function queryRegistryPath(key: string, env: NodeJS.ProcessEnv): Promise<string> {
  const systemRoot = envValue(env, "SystemRoot") ?? envValue(env, "WINDIR");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || /[\0\r\n]/u.test(systemRoot)) return "";
  const executable = path.win32.join(systemRoot, "System32", "reg.exe");
  const { stdout } = await execFileAsync(executable, ["query", key, "/v", "Path", "/reg:64"], {
    windowsHide: true,
    timeout: 1_000,
    maxBuffer: MAX_REGISTRY_PATH_BYTES,
    encoding: "utf8",
    env: { SystemRoot: systemRoot, WINDIR: systemRoot },
  });
  return stdout;
}

export async function readWindowsPersistentPath(
  env: NodeJS.ProcessEnv,
  query: (key: string, env: NodeJS.ProcessEnv) => Promise<string> = queryRegistryPath,
): Promise<readonly string[]> {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const key of REGISTRY_PATH_KEYS) {
    let output: string;
    try {
      output = await query(key, env);
    } catch {
      continue;
    }
    if (Buffer.byteLength(output, "utf8") > MAX_REGISTRY_PATH_BYTES) continue;
    const value = parseWindowsRegistryPath(output);
    if (!value) continue;
    for (const entry of value.split(";")) {
      if (directories.length >= MAX_PATH_ENTRIES) return directories;
      const directory = expandWindowsPathEntry(entry, env);
      if (!directory) continue;
      const comparable = directory.toLowerCase();
      if (seen.has(comparable)) continue;
      seen.add(comparable);
      directories.push(directory);
    }
  }
  return directories;
}
