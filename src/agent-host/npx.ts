import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { execPath, env as processEnv } from "process";

const execFileAsync = promisify(execFile);

/**
 * Locate `npx-cli.js` next to a Node binary.
 * Electron's process.execPath is Electron.app — not Node — so we also search PATH.
 */
function findNpxCliNear(nodeBinary: string): string | null {
  const nodeDir = dirname(nodeBinary);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    // Homebrew node on macOS
    join(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findSystemNode(): string | null {
  const pathEnv = processEnv.PATH ?? processEnv.Path ?? "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const dir of parts) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  // Common install locations when PATH is empty (macOS GUI apps)
  const extras = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];
  for (const p of extras) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * ISSUE-012: Prefer real Node + npx-cli.js. Never silently use Electron as node
 * unless ELECTRON_RUN_AS_NODE is intentionally set AND npx-cli is findable.
 * Fail with a clear message if system Node/npm is missing (packaged GUI PATH).
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  // 1) Real system Node (best for npm packages)
  const systemNode = findSystemNode();
  if (systemNode) {
    const npxCli = findNpxCliNear(systemNode);
    if (npxCli) {
      return execFileAsync(systemNode, [npxCli, ...args], {
        timeout: opts.timeout,
        cwd: opts.cwd,
        env: { ...processEnv, ...opts.env, FORCE_COLOR: "0" },
      });
    }
  }

  // 2) Electron as Node only if we can still find npx-cli (rare)
  const electronNpx = findNpxCliNear(execPath);
  if (electronNpx && process.versions.electron) {
    return execFileAsync(execPath, [electronNpx, ...args], {
      timeout: opts.timeout,
      cwd: opts.cwd,
      env: {
        ...processEnv,
        ...opts.env,
        ELECTRON_RUN_AS_NODE: "1",
        FORCE_COLOR: "0",
      },
    });
  }

  throw new Error(
    "Node.js/npm not found. Skills install requires a system Node.js with npm " +
      "(e.g. brew install node). Launching from Finder may omit PATH — open from a terminal or install Node system-wide.",
  );
}
