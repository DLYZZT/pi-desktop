import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import type { ToolExecutionContext } from "../shared/toolchains/types.ts";
import type { ToolchainRuntime } from "./toolchain-runtime.ts";

/** fd 10.3 on Windows cannot match full-path globs. Match its relative output before applying the limit. */
export function windowsFindMatcher(pattern: string) {
  return new Minimatch(pattern.replace(/\/\*\*$/u, "/**/*"), {
    platform: "win32",
    dot: true,
    noext: true,
    nonegate: true,
    nocomment: true,
    nocase: pattern === pattern.toLowerCase(),
  });
}

export async function findWithToolchain(
  pattern: string,
  directory: string,
  limit: number,
  inGit: boolean,
  signal: AbortSignal | undefined,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime,
): Promise<string[]> {
  // Keep the caller's spelling of the root. fd reports and full-path-matches the search path as given, so a
  // symlinked, junction or 8.3 root stays comparable with absolute patterns written through that same path.
  const root = path.resolve(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const windows = process.platform === "win32";
  const glob = (windows ? pattern.replaceAll("\\", "/") : pattern).replace(/^(?:\.\/)+/u, "");
  const pathPattern = glob.includes("/");
  const matcher = windows && pathPattern ? windowsFindMatcher(glob) : undefined;
  const args = ["--color=never", "--hidden", "--print0", "--exclude", ".git", "--exclude", "node_modules"];
  if (!inGit) args.push("--no-require-git");
  if (matcher) args.push("--", "", root);
  else {
    args.push("--glob", "--max-results", String(limit));
    let needle = glob;
    if (pathPattern) {
      args.push("--full-path");
      if (!path.isAbsolute(glob)) {
        const prefix = root.replace(/\/+$/u, "").replace(/[\\*?[\]{}]/gu, "\\$&");
        needle = `${prefix}/${glob}`;
        if (glob === glob.toLowerCase()) args.push("--ignore-case");
      }
    }
    args.push("--", needle, root);
  }
  signal?.throwIfAborted();
  const child = runtime.spawnFromContext("search.fd", args, context, { cwd: root, stdio: "pipe", windowsHide: true });
  return new Promise((resolve, reject) => {
    const files: string[] = [];
    let pending = "",
      stderr = "";
    const stop = () => {
      if (!child.killed) child.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      const paths = (pending + chunk).split("\0");
      pending = paths.pop()!;
      for (const file of paths) {
        if (files.length >= limit) break;
        const absolute = path.resolve(root, file);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const candidate = path.isAbsolute(glob) ? absolute.split(path.sep).join("/") : relative;
        if (!matcher || matcher.match(candidate)) files.push(relative);
        if (matcher && files.length === limit) stop();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("Operation aborted"));
      else if (code !== 0 && !(matcher && files.length === limit))
        reject(new Error(stderr.trim() || `fd exited with code ${code}`));
      else resolve(files);
    });
  });
}
