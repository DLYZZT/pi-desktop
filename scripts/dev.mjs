#!/usr/bin/env node
/**
 * Dev orchestration: Vite (renderer) + tsup watch (main/preload/host) + Electron.
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, ...opts.env },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (opts.fatal !== false && code && code !== 0) {
      console.error(`[dev] ${cmd} exited ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 1) Build main once, then watch
console.log("[dev] building main/preload/host…");
const build = spawn("npx", ["tsup", "--config", "tsup.config.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: isWin,
});
build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev] initial tsup failed");
    process.exit(code ?? 1);
  }

  run("npx", ["tsup", "--config", "tsup.config.ts", "--watch"], { fatal: false });
  run("npx", ["vite", "--config", "vite.config.ts"], { fatal: false });

  // Wait for vite, then launch electron
  setTimeout(() => {
    console.log("[dev] starting electron…");
    run(path.join(root, "node_modules", ".bin", isWin ? "electron.cmd" : "electron"), ["."], {
      env: {
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    });
  }, 2000);
});
