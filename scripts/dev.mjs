#!/usr/bin/env node
/** Dev orchestration: Vite (renderer) + tsup watch (main/preload/host) + Electron. */

import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary, resolvePackageFile, terminateProcessTree } from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererUrl = "http://localhost:5173";

export async function waitForViteReady(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = now() + timeoutMs;
  let lastFailure = "no response";

  while (now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - now());
      const response = await fetchImpl(url, { signal: globalThis.AbortSignal.timeout(Math.min(1_000, remaining)) });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Vite did not become ready at ${url} within ${timeoutMs}ms (last failure: ${lastFailure})`);
}

export function createDevRuntime(projectRoot = root) {
  const children = new Set();
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) terminateProcessTree(child);
    process.exit(code);
  };

  const run = (label, command, args, options = {}) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env },
    });
    children.add(child);
    child.once("error", (error) => {
      children.delete(child);
      if (!shuttingDown && options.fatal !== false) {
        console.error(`[dev] ${label} failed to start: ${error.message}`);
        shutdown(1);
      }
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (!shuttingDown && options.fatal !== false) {
        console.error(`[dev] ${label} exited code=${code ?? "none"} signal=${signal ?? "none"}`);
        const exitCode = code === 0 ? (options.allowCleanExit ? 0 : 1) : (code ?? 1);
        shutdown(exitCode);
      }
    });
    return child;
  };

  return { children, run, shutdown };
}

export function superviseRestartableProcess(options) {
  const restartDelayMs = options.restartDelayMs ?? 200;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let child;
  let restartTimer;
  let restartRequested = false;
  let disposed = false;

  const start = () => {
    child = options.start();
    let settled = false;
    child.once("error", (error) => {
      if (settled || disposed) return;
      settled = true;
      options.onUnexpectedExit({ error });
    });
    child.once("exit", (code, signal) => {
      if (settled || disposed) return;
      settled = true;
      if (restartRequested) {
        restartRequested = false;
        start();
        return;
      }
      options.onUnexpectedExit({ code, signal });
    });
  };

  const scheduleRestart = () => {
    if (disposed || restartRequested) return;
    if (restartTimer) clearTimer(restartTimer);
    restartTimer = setTimer(() => {
      restartTimer = undefined;
      restartRequested = true;
      options.stop(child);
    }, restartDelayMs);
  };

  const dispose = () => {
    disposed = true;
    if (restartTimer) clearTimer(restartTimer);
  };

  start();
  return { dispose, scheduleRestart };
}

async function waitForSuccessfulBuild(child) {
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw new Error(`initial build failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`initial build terminated by signal ${result.signal}`);
  if (result.code !== 0) throw new Error(`initial build exited with status ${result.code ?? "none"}`);
}

export async function runDev(projectRoot = root) {
  const runtime = createDevRuntime(projectRoot);
  process.once("SIGINT", () => runtime.shutdown(0));
  process.once("SIGTERM", () => runtime.shutdown(0));

  console.log("[dev] building main/preload/host…");
  const initialBuild = runtime.run("initial build", process.execPath, ["scripts/build-main.mjs"], { fatal: false });
  try {
    await waitForSuccessfulBuild(initialBuild);
    const tsupCli = resolvePackageFile(projectRoot, "tsup", "dist/cli-default.js");
    const viteCli = resolvePackageFile(projectRoot, "vite", "bin/vite.js");
    runtime.run("tsup watch", process.execPath, [tsupCli, "--config", "tsup.config.ts", "--watch"]);
    runtime.run("Vite", process.execPath, [viteCli, "--config", "vite.config.ts"]);
    await waitForViteReady(rendererUrl);

    console.log("[dev] Vite ready; starting Electron…");
    const userDataDir = process.env.PI_DESKTOP_USER_DATA_DIR;
    const electronArgs = [".", ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])];
    const electronOptions = {
      fatal: false,
      env: {
        VITE_DEV_SERVER_URL: rendererUrl,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    };
    const electron = superviseRestartableProcess({
      start: () => runtime.run("Electron", resolveElectronBinary(projectRoot), electronArgs, electronOptions),
      stop: (child) => terminateProcessTree(child),
      onUnexpectedExit: ({ error, code, signal }) => {
        if (error) {
          console.error(`[dev] Electron failed to start: ${error.message}`);
          runtime.shutdown(1);
          return;
        }
        console.error(`[dev] Electron exited code=${code ?? "none"} signal=${signal ?? "none"}`);
        runtime.shutdown(code === 0 ? 0 : (code ?? 1));
      },
    });
    const mainBundle = path.join(projectRoot, "out", "main", "main.js");
    watchFile(mainBundle, { interval: 250 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) return;
      console.log("[dev] main process rebuilt; restarting Electron…");
      electron.scheduleRestart();
    });
    process.once("exit", () => {
      electron.dispose();
      unwatchFile(mainBundle);
    });
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : error}`);
    runtime.shutdown(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) void runDev();
