/**
 * Pi Agent Desktop v2 — Electron main process
 * Responsibilities: window lifecycle, menus, tray/badge, deep link,
 * Host supervision, system IPC. No business logic.
 */
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  nativeTheme,
  nativeImage,
  Notification,
  shell,
} from "electron";
import path from "path";
import { HostManager, resolveHostEntry, resolvePreloadPath, resolveRendererEntry } from "./host-manager";
import { appendMainLog, getMainLogPath } from "./logger";
import { installAppMenu } from "./menu";
import {
  createHtmlPreviewUrl,
  handleAppProtocol,
  registerAppProtocol,
  releaseHtmlPreviewUrl,
  rendererRootPath,
} from "./protocol";
import { acquireSingleInstanceLock } from "./single-instance";
import { applyWindowBounds, loadUiState, saveUiState, shouldMaximize, trackWindowState } from "./window-state";
import { createTray, destroyTray, setTrayRunningCount } from "./tray";
import { exportDiagnostics } from "./diagnostics";
import type { SaveBinaryFileOptions, SaveTextFileOptions } from "../contract/desktop";

// Must run before app ready
registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop",
  uploadToServer: false,
  compress: false,
});

const BACKGROUND = "#f7f6f3";
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let isQuitting = false;
let unreadBadge = 0;
let pendingDeepLink: string | null = null;
let smokeChecksStarted = false;
let smokeRendererSecurityViolation: string | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function applyBadgeCount(count: number): void {
  unreadBadge = Math.max(0, Number(count) || 0);
  if (process.platform === "win32") {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (unreadBadge === 0) {
      win.setOverlayIcon(null, "No unread completed sessions");
      return;
    }
    const overlay = nativeImage
      .createFromPath(path.join(app.getAppPath(), "build", "icon.png"))
      .resize({ width: 16, height: 16 });
    win.setOverlayIcon(overlay, `${unreadBadge} unread completed session${unreadBadge === 1 ? "" : "s"}`);
    return;
  }
  app.setBadgeCount(unreadBadge);
}

async function runSmokeHostChecks(manager: HostManager): Promise<void> {
  const { port1 } = manager.createRendererChannel();
  let requestId = 0;
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const eventWaiters = new Map<string, {
    topic: string;
    key: string;
    predicate: (data: unknown) => boolean;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  port1.on("message", (event) => {
    const message = event.data as {
      kind?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; message?: string; detail?: unknown };
      topic?: string;
      key?: string;
      data?: unknown;
    };
    if (message.kind === "event") {
      for (const [id, waiter] of eventWaiters) {
        if (waiter.topic !== message.topic || waiter.key !== message.key || !waiter.predicate(message.data)) continue;
        eventWaiters.delete(id);
        clearTimeout(waiter.timer);
        port1.postMessage({ kind: "unsubscribe", id, topic: waiter.topic, key: waiter.key });
        waiter.resolve(message.data);
      }
      return;
    }
    if (message.kind !== "response" || !message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? "Smoke RPC failed") as Error & {
        code?: string;
        detail?: unknown;
      };
      error.code = message.error?.code;
      error.detail = message.error?.detail;
      entry.reject(error);
    }
  });
  port1.start();

  const call = <T,>(method: string, params?: unknown): Promise<T> => {
    const id = `smoke-${++requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Smoke RPC timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      port1.postMessage({ kind: "request", id, method, params });
    });
  };

  const waitForEvent = (
    topic: string,
    key: string,
    predicate: (data: unknown) => boolean,
  ): Promise<unknown> => {
    const id = `smoke-event-${++requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        eventWaiters.delete(id);
        port1.postMessage({ kind: "unsubscribe", id, topic, key });
        reject(new Error(`Smoke event timed out: ${topic}:${key}`));
      }, 10_000);
      eventWaiters.set(id, { topic, key, predicate, resolve, reject, timer });
      port1.postMessage({ kind: "subscribe", id, topic, key });
    });
  };

  try {
    await call("host.ping");
    await call("sessions.list");
    await call("system.allowRoot", { path: process.cwd() });
    const status = await call<{ isGit?: boolean }>("git.status", { path: process.cwd() });
    if (typeof status.isGit !== "boolean") throw new Error("git.status returned an invalid shape");
    const fs = await import("fs");
    const packagePath = path.join(process.cwd(), "package.json");
    const download = await call<{ base64?: string; size?: number }>("files.download", { path: packagePath });
    const expected = fs.readFileSync(packagePath);
    if (!download.base64 || download.size !== expected.length || !Buffer.from(download.base64, "base64").equals(expected)) {
      throw new Error("files.download did not preserve exact bytes");
    }
    const os = await import("os");
    const { execFileSync } = await import("child_process");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-smoke-"));
    const worktreeParent = `${repo}-worktrees`;
    try {
      execFileSync("git", ["init", "-q", repo]);
      fs.writeFileSync(path.join(repo, "README.md"), "smoke\n");
      execFileSync("git", ["-C", repo, "add", "README.md"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Pi Desktop", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "initial"]);
      await call("system.allowRoot", { path: repo });
      const skillDir = path.join(repo, ".pi", "skills", "smoke-skill");
      const skillPath = path.join(skillDir, "SKILL.md");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, "---\nname: smoke-skill\ndescription: smoke\n---\n\nOriginal body.\n");
      const skills = await call<{ skills?: Array<{ name?: string; filePath?: string }> }>("skills.list", { cwd: repo });
      const smokeSkill = skills.skills?.find((skill) => skill.name === "smoke-skill");
      if (!smokeSkill?.filePath) throw new Error("skills.list did not load the project smoke skill");
      const updatedSkill = "---\nname: smoke-skill\ndescription: edited smoke\n---\n\nEdited body.\n";
      await call("skills.set", { cwd: repo, filePath: smokeSkill.filePath, content: updatedSkill });
      const skillContent = await call<{ content?: string }>("skills.getContent", { cwd: repo, filePath: smokeSkill.filePath });
      if (skillContent.content !== updatedSkill) throw new Error("skills.set did not persist exact content");
      await call("files.watchStart", { path: repo });
      const changeEvent = waitForEvent(
        "files.changed",
        repo,
        (data) => (data as { event?: string } | null)?.event === "change",
      );
      // A ping on the same port is a barrier ensuring the subscription was processed.
      await call("host.ping");
      fs.writeFileSync(path.join(repo, "watch-change.txt"), "changed\n");
      await changeEvent;
      await call("files.watchStop", { path: repo });
      const repoStatus = await call<{ isGit?: boolean; untracked?: number }>("git.status", { path: repo });
      if (!repoStatus.isGit || !repoStatus.untracked) throw new Error("git.status did not report project changes");
      const created = await call<{ worktree?: { path?: string } }>("worktrees.create", {
        projectRoot: repo,
        cwd: repo,
        branch: "smoke-worktree",
      });
      const worktreePath = created.worktree?.path;
      if (!worktreePath || !fs.existsSync(worktreePath)) throw new Error("worktrees.create returned an invalid path");
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "dirty\n");
      let dirtyConflict = false;
      try {
        await call("worktrees.remove", { cwd: repo, path: worktreePath, force: false });
      } catch (error) {
        dirtyConflict = (error as { detail?: { dirty?: boolean } }).detail?.dirty === true;
      }
      if (!dirtyConflict) throw new Error("dirty worktree removal did not return structured conflict detail");
      await call("worktrees.remove", { cwd: repo, path: worktreePath, force: true });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
    }

    const smokeWindow = createWindow();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Renderer smoke load timed out")), 15_000);
        const loaded = () => {
          clearTimeout(timer);
          resolve();
        };
        if (!smokeWindow.webContents.isLoadingMainFrame()) loaded();
        else smokeWindow.webContents.once("did-finish-load", loaded);
      });
      const rendererResult = await smokeWindow.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const check = async () => {
            try {
              const root = document.getElementById("root");
              if (window.piBridge && root && root.childElementCount > 0) {
                const status = await fetch(${JSON.stringify(`/api/git-status?cwd=${encodeURIComponent(process.cwd())}`)}).then((response) => response.json());
                const token = "pi-html-preview-smoke-" + Math.random().toString(36).slice(2);
                const previewUrl = await window.piBridge.createHtmlPreview(
                  "<!doctype html><img id='asset' src='./icon.png'><script>addEventListener('load',()=>{if(asset.naturalWidth)parent.postMessage(" + JSON.stringify(token) + ",'*')})<\\/script>",
                  ${JSON.stringify(path.join(process.cwd(), "build", "smoke.html"))},
                );
                const previewRendered = await new Promise((previewResolve, previewReject) => {
                  const frame = document.createElement("iframe");
                  frame.sandbox = "allow-scripts";
                  frame.style.display = "none";
                  const previewTimer = setTimeout(() => {
                    cleanup();
                    previewReject(new Error("Sandboxed HTML preview did not execute"));
                  }, 3000);
                  const onMessage = (event) => {
                    if (event.data !== token) return;
                    cleanup();
                    previewResolve(true);
                  };
                  const cleanup = () => {
                    clearTimeout(previewTimer);
                    window.removeEventListener("message", onMessage);
                    frame.remove();
                    void window.piBridge.releaseHtmlPreview(previewUrl);
                  };
                  window.addEventListener("message", onMessage);
                  frame.src = previewUrl;
                  document.body.appendChild(frame);
                });
                resolve({
                  bridge: typeof window.piBridge.saveBinaryFile === "function",
                  rendered: root.childElementCount > 0,
                  gitStatus: typeof status.isGit === "boolean",
                  htmlPreview: previewRendered,
                });
                return;
              }
            } catch (error) {
              reject(error);
              return;
            }
            if (Date.now() >= deadline) reject(new Error("Renderer did not become ready"));
            else setTimeout(check, 50);
          };
          void check();
        })
      `) as { bridge?: boolean; rendered?: boolean; gitStatus?: boolean; htmlPreview?: boolean };
      if (!rendererResult.bridge || !rendererResult.rendered || !rendererResult.gitStatus || !rendererResult.htmlPreview) {
        throw new Error(`Renderer smoke returned invalid result: ${JSON.stringify(rendererResult)}`);
      }
      if (smokeRendererSecurityViolation) {
        throw new Error(`Renderer security violation: ${smokeRendererSecurityViolation}`);
      }
    } finally {
      if (!smokeWindow.isDestroyed()) smokeWindow.destroy();
    }
    appendMainLog("smoke: renderer/RPC/session/worktree/git/watch/download/skills checks passed");
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Smoke port closed"));
    }
    pending.clear();
    for (const [id, waiter] of eventWaiters) {
      clearTimeout(waiter.timer);
      port1.postMessage({ kind: "unsubscribe", id, topic: waiter.topic, key: waiter.key });
      waiter.reject(new Error("Smoke port closed"));
    }
    eventWaiters.clear();
    port1.close();
  }
}

function parseDeepLink(url: string): { sessionId?: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "pi-agent-desktop:") return null;
    // pi-agent-desktop://session/<id>
    if (u.hostname === "session" || u.pathname.startsWith("/session/")) {
      const id =
        u.hostname === "session"
          ? u.pathname.replace(/^\//, "")
          : u.pathname.replace(/^\/session\//, "");
      return id ? { sessionId: id } : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function handleDeepLink(url: string): void {
  appendMainLog(`deep link: ${url}`);
  const parsed = parseDeepLink(url);
  if (!parsed?.sessionId) return;
  const win = getMainWindow();
  if (win) {
    win.webContents.send("deep-link:session", parsed.sessionId);
    win.show();
    win.focus();
  } else {
    pendingDeepLink = parsed.sessionId;
  }
}

if (!acquireSingleInstanceLock(getMainWindow, (argv) => {
  const url = argv.find((a) => a.startsWith("pi-agent-desktop://"));
  if (url) handleDeepLink(url);
})) {
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function createWindow(): BrowserWindow {
  const ui = loadUiState();
  const bounds = applyWindowBounds(
    { x: undefined as unknown as number, y: undefined as unknown as number, width: 1280, height: 840 },
    ui,
  );

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Agent Desktop",
    backgroundColor: BACKGROUND,
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = win;
  if (unreadBadge > 0) applyBadgeCount(unreadBadge);
  trackWindowState(win);
  if (shouldMaximize(ui) && !win.isDestroyed()) {
    win.maximize();
  }

  const showWin = () => {
    if (process.env.PI_SMOKE_TEST === "1") return;
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      if (isDev || process.env.PI_DESKTOP_DEVTOOLS === "1") {
        win.webContents.openDevTools({ mode: "detach" });
      }
    }
  };
  win.once("ready-to-show", showWin);
  setTimeout(showWin, 3_000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const allowed =
      url.startsWith("app://") ||
      url.startsWith("http://localhost:5173") ||
      url.startsWith("http://127.0.0.1:5173");
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (process.platform === "darwin" && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    appendMainLog(`render-process-gone: ${details.reason}`);
    if (!win.isDestroyed()) win.reload();
  });

  // Connect renderer ↔ Host via MessagePort after DOM ready
  win.webContents.on("did-finish-load", () => {
    if (pendingDeepLink) {
      win.webContents.send("deep-link:session", pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendMainLog(`did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
    const help =
      `<!DOCTYPE html><html><body style="font-family:system-ui;background:#f7f6f3;padding:40px;color:#1c1a17">` +
      `<h1 style="font-family:ui-monospace,monospace;font-size:18px">Cannot load UI</h1>` +
      `<p style="color:#57534a;font-size:13.5px;line-height:1.55">Failed to load <code>${validatedURL || url}</code><br/>Error ${code}: ${desc}</p>` +
      `<p style="color:#57534a;font-size:13.5px">Try: <code>npm run build && npm start</code> or <code>npm run dev</code></p>` +
      `</body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(help)}`);
  });

  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      appendMainLog(`renderer[${level}] ${message} (${sourceId}:${line})`);
      if (process.env.PI_SMOKE_TEST === "1" && /Content Security Policy/i.test(message)) {
        smokeRendererSecurityViolation = message;
      }
    }
  });

  const url = resolveRendererEntry(isDev);
  appendMainLog(`loadURL ${url}`);
  void win.loadURL(url);

  return win;
}

function installIpc(): void {
  ipcMain.handle("desktop:get-version", () => app.getVersion());

  ipcMain.handle("desktop:get-host-status", () => hostManager?.getStatus() ?? "stopped");

  ipcMain.on("desktop:connect-host", (event) => {
    if (!hostManager) return;
    const { port1 } = hostManager.createRendererChannel();
    event.sender.postMessage("desktop:host-port", null, [port1]);
  });

  ipcMain.handle("desktop:open-external", async (_e, url: string) => {
    if (typeof url !== "string") return;
    if (!/^(https?:|mailto:)/i.test(url)) {
      throw new Error("Blocked non-http(s)/mailto URL");
    }
    await shell.openExternal(url);
  });

  ipcMain.handle("desktop:show-item-in-folder", async (_e, fsPath: string) => {
    if (typeof fsPath !== "string") return;
    shell.showItemInFolder(fsPath);
  });

  ipcMain.handle("desktop:select-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ui = loadUiState();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: ui.recentCwds?.[0],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const dir = result.filePaths[0];
    const recent = [dir, ...(ui.recentCwds ?? []).filter((p) => p !== dir)].slice(0, 12);
    saveUiState({ recentCwds: recent });
    return dir;
  });

  ipcMain.handle(
    "desktop:save-file",
    async (event, opts: SaveTextFileOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: opts.defaultPath,
        filters: opts.filters ?? [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return null;
      const fs = await import("fs");
      fs.writeFileSync(result.filePath, opts.content, "utf8");
      return result.filePath;
    },
  );

  ipcMain.handle(
    "desktop:save-binary-file",
    async (event, opts: SaveBinaryFileOptions) => {
      if (!opts || typeof opts.base64 !== "string") {
        throw new Error("Invalid binary save payload");
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: opts.defaultPath,
      });
      if (result.canceled || !result.filePath) return null;
      const fs = await import("fs");
      fs.writeFileSync(result.filePath, Buffer.from(opts.base64, "base64"));
      return result.filePath;
    },
  );

  ipcMain.handle(
    "desktop:create-html-preview",
    (_event, content: string, filePath: string, sourceSessionId?: string | null) =>
      createHtmlPreviewUrl(content, filePath, async (assetPath) => {
        const manager = hostManager;
        if (!manager) throw new Error("Agent Host is unavailable");
        const meta = await manager.call<{ size: number }>("files.meta", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
        if (meta.size > 20 * 1024 * 1024) throw new Error("HTML preview asset is too large");
        return manager.call<{ base64: string; size: number; mime?: string }>("files.download", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
      }),
  );
  ipcMain.handle("desktop:release-html-preview", (_event, previewUrl: string) => {
    releaseHtmlPreviewUrl(previewUrl);
  });

  ipcMain.on("desktop:notify-agent-end", (_e, payload: { sessionId: string; title?: string }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: payload.title || "Agent finished",
      body: "Session completed",
    });
    n.on("click", () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send("deep-link:session", payload.sessionId);
      }
    });
    n.show();
    applyBadgeCount(unreadBadge + 1);
  });

  ipcMain.on("desktop:set-badge-count", (_e, n: number) => {
    applyBadgeCount(n);
  });

  ipcMain.handle("desktop:get-ui-state", () => loadUiState());
  ipcMain.handle("desktop:set-ui-state", (_e, patch: Record<string, unknown>) => {
    saveUiState(patch);
  });

  ipcMain.handle("desktop:get-theme-source", () => nativeTheme.themeSource);
  ipcMain.handle("desktop:set-theme-source", (_e, source: "system" | "light" | "dark") => {
    nativeTheme.themeSource = source;
    saveUiState({ theme: source });
  });

  ipcMain.handle("desktop:open-logs", () => {
    shell.showItemInFolder(getMainLogPath());
  });

  ipcMain.handle("desktop:export-diagnostics", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return exportDiagnostics(win);
  });

  ipcMain.handle("desktop:clear-badge", () => {
    applyBadgeCount(0);
  });
}

app.whenReady().then(() => {
  appendMainLog(`app ready packaged=${app.isPackaged}`);

  // Always register app:// so we can load the built renderer without Vite
  // (npm start after build, or dev fallback when VITE_DEV_SERVER_URL is unset).
  handleAppProtocol(rendererRootPath());

  installIpc();
  installAppMenu(getMainWindow);

  if (process.env.PI_SMOKE_TEST !== "1") {
    createTray(getMainWindow);
  }

  // Apply persisted theme preference
  const ui = loadUiState();
  if (ui.theme === "light" || ui.theme === "dark" || ui.theme === "system") {
    nativeTheme.themeSource = ui.theme;
  }

  hostManager = new HostManager(resolveHostEntry());
  hostManager.setStatusListener((status, detail) => {
    appendMainLog(`host status=${status} ${detail ?? ""}`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("host:status", { status, detail });
      if (status === "ready" && detail?.includes("restart")) {
        win.webContents.send("host:restarted", { reason: detail });
      }
      if (status === "crashed") {
        win.webContents.send("host:crashed", { detail });
      }
    }
    if (process.env.PI_SMOKE_TEST === "1" && status === "ready" && !smokeChecksStarted) {
      const manager = hostManager;
      if (!manager) return;
      smokeChecksStarted = true;
      appendMainLog("smoke: host ready — running RPC checks");
      void runSmokeHostChecks(manager).then(
        () => {
          isQuitting = true;
          hostManager?.stop();
          app.exit(0);
        },
        (error) => {
          appendMainLog(`smoke: checks failed — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          isQuitting = true;
          hostManager?.stop();
          app.exit(1);
        },
      );
    }
    if (process.env.PI_SMOKE_TEST === "1" && status === "crashed") {
      appendMainLog(`smoke: host crashed — ${detail}`);
      app.exit(1);
    }
  });

  hostManager.setMessageListener((msg) => {
    if (msg.type === "running-sessions") {
      const ids = (msg.sessionIds as string[]) ?? [];
      setTrayRunningCount(ids.length, getMainWindow);
    } else if (msg.type === "agent-end") {
      const sessionId = String(msg.sessionId ?? "");
      // Notify if no focused window or window is hidden (desktop value-add)
      const win = getMainWindow();
      const shouldNotify = !win || !win.isVisible() || !win.isFocused();
      if (shouldNotify && Notification.isSupported() && sessionId) {
        const n = new Notification({
          title: "Agent finished",
          body: "A session completed in the background",
        });
        n.on("click", () => {
          const w = getMainWindow();
          if (w) {
            w.show();
            w.focus();
            w.webContents.send("deep-link:session", sessionId);
          }
        });
        n.show();
        applyBadgeCount(unreadBadge + 1);
      }
    } else if (msg.type === "host-restarted") {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("host:restarted", { reason: String(msg.reason ?? "restart") });
      }
    }
  });

  hostManager.start();

  if (process.env.PI_SMOKE_TEST !== "1") {
    createWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      getMainWindow()?.show();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  destroyTray();
  hostManager?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Deep link registration
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("pi-agent-desktop", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("pi-agent-desktop");
}
