import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type GrepToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { ToolExecutionContext } from "../shared/toolchains/types.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

const DEFAULT_RESULT_LIMIT = 100;
const SEARCH_OUTPUT_LIMIT = 2 * 1024 * 1024;

/** The Desktop-owned equivalent of the upstream search runtime contract. */
export interface SearchToolRuntime {
  rgPath?: string;
  fdPath?: string;
  allowUpstreamDownload: false;
}

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgEvent {
  type?: string;
  data?: {
    path?: RgText;
    lines?: RgText;
    line_number?: number;
  };
}

interface RgResult {
  output: string;
  totalBytes: number;
  totalLines: number;
  linesTruncated: boolean;
  matchLimitReached: boolean;
}

function decodeRgText(field: RgText | undefined): string {
  return field?.text ?? (field?.bytes === undefined ? "" : Buffer.from(field.bytes, "base64").toString("utf8"));
}

export function searchToolRuntimeFromContext(context: ToolExecutionContext): SearchToolRuntime {
  return {
    rgPath: context.commands["search.rg"]?.executable,
    fdPath: context.commands["search.fd"]?.executable,
    allowUpstreamDownload: false,
  };
}

function resolveSearchPath(cwd: string, requested: string | undefined): string {
  const value = requested?.trim() || ".";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function isInsideGitRepository(start: string): Promise<boolean> {
  for (let current = start; ; current = path.dirname(current)) {
    if (await pathExists(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
  }
}

function runRg(
  args: string[],
  cwd: string,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime,
  signal: AbortSignal | undefined,
  { limit, contextLines }: { limit: number; contextLines: number },
): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    let settled = false;
    let aborted = false;
    let stoppedForLimit = false;
    let matchLimitReached = false;
    let matchCount = 0;
    let lastAllowedMatch: { file: string; contextEnd: number } | undefined;
    let stderr = "";
    const output: string[] = [];
    let outputBytes = 0;
    let totalLines = 0;
    let linesTruncated = false;
    const child = runtime.spawnFromContext("search.rg", args, context, {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    if (!child.stdout) {
      child.kill();
      reject(new Error("ripgrep stdout is unavailable"));
      return;
    }
    const lines = createInterface({ input: child.stdout });
    const cleanup = (): void => {
      lines.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const stop = (): void => {
      if (!child.killed) child.kill();
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < SEARCH_OUTPUT_LIMIT) stderr += chunk.toString();
      if (stderr.length >= SEARCH_OUTPUT_LIMIT) stop();
    });
    const appendLine = (file: string, lineNumber: number, raw: RgText | undefined, isMatch: boolean) => {
      const relative = path.relative(cwd, path.resolve(cwd, file));
      const inside =
        relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      const label = (inside ? relative : path.basename(file)).replace(/\\/g, "/");
      const { text, wasTruncated } = truncateLine(decodeRgText(raw).replace(/\r?\n$/u, ""));
      linesTruncated ||= wasTruncated;
      const separator = isMatch ? ":" : "-";
      const formatted = `${label}${separator}${lineNumber}${separator} ${text}`;
      // Retain the first line over the byte budget so truncateHead can report truncation.
      if (outputBytes - 1 <= DEFAULT_MAX_BYTES) output.push(formatted);
      outputBytes += Buffer.byteLength(formatted) + 1;
      totalLines++;
    };
    lines.on("line", (line) => {
      if (!line.trim() || stoppedForLimit || aborted) return;
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        return;
      }
      const isMatch = event.type === "match";
      if (!isMatch && event.type !== "context") return;
      const file = decodeRgText(event.data?.path);
      const lineNumber = event.data?.line_number;
      if (!file || typeof lineNumber !== "number") return;
      if (!lastAllowedMatch) {
        appendLine(file, lineNumber, event.data?.lines, isMatch);
        if (isMatch && ++matchCount === limit) lastAllowedMatch = { file, contextEnd: lineNumber + contextLines };
        return;
      }
      // Keep the last match's trailing context, including nearby matches presented as context.
      const inTrailingContext = file === lastAllowedMatch.file && lineNumber <= lastAllowedMatch.contextEnd;
      if (inTrailingContext) appendLine(file, lineNumber, event.data?.lines, false);
      if (isMatch) matchLimitReached = true;
      if (!matchLimitReached || (inTrailingContext && lineNumber < lastAllowedMatch.contextEnd)) return;
      if (!child.killed) stoppedForLimit = child.kill();
    });
    child.once("error", (error) => finish(() => reject(new Error(`Failed to run ripgrep: ${error.message}`))));
    child.once("close", (code) => {
      if (aborted) {
        finish(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        finish(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`)));
        return;
      }
      finish(() =>
        resolve({
          output: matchCount > 0 ? output.join("\n") : "",
          totalBytes: Math.max(0, outputBytes - 1),
          totalLines,
          linesTruncated,
          matchLimitReached,
        }),
      );
    });
  });
}

export function createDesktopSearchToolDefinitions(
  cwd: string,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
): [ReturnType<typeof createGrepToolDefinition>, ReturnType<typeof createFindToolDefinition>] {
  const grep = createGrepToolDefinition(cwd);
  grep.execute = async (_toolCallId, input, signal) => {
    const searchPath = resolveSearchPath(cwd, input.path);
    let directory: boolean;
    try {
      directory = (await fs.stat(searchPath)).isDirectory();
    } catch {
      throw new Error(`Path not found: ${searchPath}`);
    }
    const effectiveLimit = Math.max(1, Math.floor(input.limit ?? DEFAULT_RESULT_LIMIT));
    const contextLines = Math.min(Math.max(0, Math.floor(input.context ?? 0)), Number.MAX_SAFE_INTEGER);
    // --no-config: RIPGREP_CONFIG_PATH must not change the tool contract (regex vs literal, globs, limits).
    const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden", "--max-columns", "2000"];
    if (input.ignoreCase) args.push("--ignore-case");
    if (input.literal) args.push("--fixed-strings");
    if (input.glob) args.push("--glob", input.glob.replace(/^(!?)(?:\.\/)+/u, "$1"));
    if (contextLines > 0) args.push("--context", String(contextLines));
    // Searching "." also works when ripgrep canonicalizes a symlinked search directory.
    args.push("--", input.pattern, directory ? "." : searchPath);

    const searchRoot = directory ? searchPath : path.dirname(searchPath);
    const result = await runRg(args, searchRoot, context, runtime, signal, { limit: effectiveLimit, contextLines });
    if (!result.output) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

    const truncation = truncateHead(result.output, { maxLines: Number.MAX_SAFE_INTEGER });
    const details: GrepToolDetails = {};
    const notices: string[] = [];
    if (result.matchLimitReached) {
      details.matchLimitReached = effectiveLimit;
      notices.push(
        `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
      );
    }
    if (truncation.truncated) {
      truncation.totalBytes = result.totalBytes;
      truncation.totalLines = result.totalLines;
      details.truncation = truncation;
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }
    if (result.linesTruncated) {
      details.linesTruncated = true;
      notices.push("Some long lines were truncated. Use read to inspect the full line");
    }
    const text = `${truncation.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
  };

  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: pathExists,
      async glob(pattern, searchPath, options) {
        const args = [
          "--glob",
          "--color=never",
          "--hidden",
          "--absolute-path",
          "--print0",
          "--exclude",
          ".git",
          "--exclude",
          "node_modules",
        ];
        if (!(await isInsideGitRepository(searchPath))) args.push("--no-require-git");
        args.push("--max-results", String(Math.max(1, options.limit)));
        let effectivePattern = pattern;
        if (pattern.includes("/")) {
          args.push("--full-path");
          if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
            effectivePattern = `**/${pattern}`;
          }
        }
        args.push("--", effectivePattern, searchPath);
        const result = await runtime.execFromContext("search.fd", args, context, {
          cwd,
          maxBuffer: SEARCH_OUTPUT_LIMIT,
        });
        return result.stdout
          .split("\0")
          .map((entry) => entry.trim())
          .filter(Boolean);
      },
    },
  });

  return [grep, find];
}
