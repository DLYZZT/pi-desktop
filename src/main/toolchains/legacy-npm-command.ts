import fs from "node:fs";
import path from "node:path";

const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_COMMAND_PARTS = 16;
const MAX_COMMAND_PART_BYTES = 4_096;
const MAX_COMMAND_BYTES = 16_384;

export interface LegacyNpmCommandOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Reads the upstream Pi npmCommand compatibility setting without creating a
 * SettingsManager (which may later flush unrelated settings). The value is
 * only a discovery input: callers must resolve and probe it before use.
 */
export function readLegacyNpmCommand(options: LegacyNpmCommandOptions): string[] | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const configuredRoot = environmentValue(env, "PI_CODING_AGENT_DIR", platform);
  const agentRoot = configuredRoot
    ? expandHome(configuredRoot, options.homeDir, platform)
    : pathFor(platform).join(options.homeDir, ".pi", "agent");
  if (!pathFor(platform).isAbsolute(agentRoot)) return undefined;
  const settingsPath = pathFor(platform).join(agentRoot, "settings.json");

  try {
    const stat = fs.statSync(settingsPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SETTINGS_BYTES) return undefined;
    const value = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return validateLegacyNpmCommand((value as { npmCommand?: unknown }).npmCommand);
  } catch {
    return undefined;
  }
}

export function validateLegacyNpmCommand(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_PARTS) return undefined;
  let bytes = 0;
  const command: string[] = [];
  for (const part of value) {
    if (
      typeof part !== "string" ||
      part.length === 0 ||
      part.length > MAX_COMMAND_PART_BYTES ||
      /[\0\r\n]/.test(part)
    ) {
      return undefined;
    }
    bytes += Buffer.byteLength(part);
    if (bytes > MAX_COMMAND_BYTES) return undefined;
    command.push(part);
  }
  return command;
}

function pathFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function environmentValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const actual = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actual ? env[actual] : undefined;
}

function expandHome(value: string, homeDir: string, platform: NodeJS.Platform): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    return pathFor(platform).join(homeDir, value.slice(2));
  }
  return value;
}
