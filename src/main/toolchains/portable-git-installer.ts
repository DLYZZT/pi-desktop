import fs from "node:fs";
import path from "node:path";
import type { ProbeExecutor } from "./process-runner.ts";

export type AuthenticodeStatus = "valid" | "invalid" | "unavailable";

export interface PortableGitSfxOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  executor: ProbeExecutor;
  verifyAuthenticode?: (artifactPath: string) => Promise<AuthenticodeStatus>;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? env[match] : undefined;
}

function findWindowsPowerShell(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = environmentValue(env, "SystemRoot") ?? "C:\\Windows";
  const candidates = [
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.win32.join(systemRoot, "System32", "pwsh.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function defaultAuthenticodeStatus(
  artifactPath: string,
  env: NodeJS.ProcessEnv,
  executor: ProbeExecutor,
): Promise<AuthenticodeStatus> {
  const powershell = findWindowsPowerShell(env);
  if (!powershell) return "unavailable";
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0]; " +
    "[Console]::Out.Write((@{Status=$s.Status.ToString()}) | ConvertTo-Json -Compress)";
  const result = await executor.run({
    executable: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, artifactPath],
    env,
    timeoutMs: 30_000,
    outputLimitBytes: 16 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnErrorCode) {
    return "unavailable";
  }
  try {
    const value = JSON.parse(result.stdout) as { Status?: unknown };
    return value.Status === "Valid" ? "valid" : "invalid";
  } catch {
    return "unavailable";
  }
}

function requireRegularFileInside(root: string, filePath: string): void {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`PortableGit is missing ${path.basename(filePath)}`);
  const canonicalRoot = fs.realpathSync.native(root);
  const canonicalFile = fs.realpathSync.native(filePath);
  if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("PortableGit extraction escaped the staging directory");
  }
}

/** Extract a hash-verified official PortableGit 7-Zip self-extractor without elevation. */
export async function extractPortableGitSfx(
  artifactPath: string,
  destination: string,
  options: PortableGitSfxOptions,
): Promise<void> {
  if (options.platform !== "win32") throw new Error("PortableGit extraction is restricted to Windows");
  if (!path.isAbsolute(artifactPath) || !path.isAbsolute(destination)) {
    throw new Error("PortableGit extraction paths must be absolute");
  }
  const artifactStats = fs.lstatSync(artifactPath);
  if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) {
    throw new Error("PortableGit artifact must be a regular file");
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(destination).length !== 0) throw new Error("PortableGit staging directory must be empty");

  const signatureStatus = options.verifyAuthenticode
    ? await options.verifyAuthenticode(artifactPath)
    : await defaultAuthenticodeStatus(artifactPath, options.env, options.executor);
  if (signatureStatus === "invalid") throw new Error("PortableGit Authenticode signature is invalid");

  const temporaryDirectory = `${destination}.sfx-temp`;
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  try {
    const result = await options.executor.run({
      executable: artifactPath,
      args: ["-y", `-o${destination}`],
      cwd: path.dirname(destination),
      env: { ...options.env, TEMP: temporaryDirectory, TMP: temporaryDirectory },
      timeoutMs: 180_000,
      outputLimitBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnErrorCode) {
      throw new Error(result.stderr.trim() || "PortableGit self-extractor failed");
    }
    requireRegularFileInside(destination, path.join(destination, "cmd", "git.exe"));
    requireRegularFileInside(destination, path.join(destination, "bin", "bash.exe"));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
