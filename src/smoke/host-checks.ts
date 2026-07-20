import type { BrowserWindow } from "electron";
import path from "path";
import type { HostManager } from "../main/host-manager";
import { appendMainLog } from "../main/logger";

export async function runSmokeHostChecks(
  manager: HostManager,
  createWindow: (onConsoleError: (message: string) => void) => BrowserWindow,
): Promise<void> {
  let rendererSecurityViolation: string | null = null;
  const { port1 } = manager.createRendererChannel();
  let requestId = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const eventWaiters = new Map<
    string,
    {
      topic: string;
      key: string;
      predicate: (data: unknown) => boolean;
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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

  const call = <T>(method: string, params?: unknown): Promise<T> => {
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

  const waitForEvent = (topic: string, key: string, predicate: (data: unknown) => boolean): Promise<unknown> => {
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
    const ackDeadline = Date.now() + 5_000;
    while (manager.getToolchainAckRevision() < 0 && Date.now() < ackDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const acknowledgedRevision = manager.getToolchainAckRevision();
    if (acknowledgedRevision < 0) throw new Error("Agent Host did not acknowledge its toolchain snapshot");
    const hostToolchain = await call<{
      inventoryRevision?: number;
      resolutionId?: string;
      capabilities?: Record<string, { provider?: string; version?: string }>;
    }>("host.toolchain", { cwd: process.cwd() });
    if (
      hostToolchain.inventoryRevision !== acknowledgedRevision ||
      !hostToolchain.resolutionId ||
      !hostToolchain.capabilities?.["vcs.git"]?.provider
    ) {
      throw new Error(`Agent Host toolchain snapshot mismatch: ${JSON.stringify(hostToolchain)}`);
    }
    await call("sessions.list");
    const channels = await call<{ accounts?: unknown[]; statuses?: unknown[]; bindings?: unknown[] }>("channels.list");
    if (!Array.isArray(channels.accounts) || !Array.isArray(channels.statuses) || !Array.isArray(channels.bindings)) {
      throw new Error("channels.list returned an invalid shape");
    }
    await call("system.allowRoot", { path: process.cwd() });
    const status = await call<{ isGit?: boolean }>("git.status", { path: process.cwd() });
    if (typeof status.isGit !== "boolean") throw new Error("git.status returned an invalid shape");
    const fs = await import("fs");
    const packagePath = path.join(process.cwd(), "package.json");
    const download = await call<{ base64?: string; size?: number }>("files.download", { path: packagePath });
    const expected = fs.readFileSync(packagePath);
    if (
      !download.base64 ||
      download.size !== expected.length ||
      !Buffer.from(download.base64, "base64").equals(expected)
    ) {
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
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=Pi Desktop",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "-qm",
        "initial",
      ]);
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
      const skillContent = await call<{ content?: string }>("skills.getContent", {
        cwd: repo,
        filePath: smokeSkill.filePath,
      });
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

    const smokeWindow = createWindow((message) => {
      if (/Content Security Policy/i.test(message)) rendererSecurityViolation = message;
    });
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
      const rendererResult = (await smokeWindow.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const check = async () => {
            try {
              const root = document.getElementById("root");
              if (window.piBridge && root && root.childElementCount > 0) {
                const findButton = (text) => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
                const settingsButton = document.querySelector('button[title="Settings"],button[title="设置"]');
                if (!settingsButton) {
                  if (Date.now() >= deadline) throw new Error("Settings button is unavailable");
                  setTimeout(check, 50);
                  return;
                }
                settingsButton.click();
                const settingsDeadline = Date.now() + 3000;
                let channelsButton;
                while (!channelsButton && Date.now() < settingsDeadline) {
                  channelsButton = findButton("Channels") || findButton("消息渠道");
                  if (!channelsButton) await new Promise((wait) => setTimeout(wait, 25));
                }
                if (!channelsButton) throw new Error("Channels settings tab is unavailable");
                channelsButton.click();
                const channelDeadline = Date.now() + 3000;
                let weixinConnectButton;
                let telegramConnectButton;
                while ((!weixinConnectButton || !telegramConnectButton) && Date.now() < channelDeadline) {
                  weixinConnectButton = findButton("Connect WeChat") || findButton("连接微信");
                  telegramConnectButton = findButton("Connect Telegram") || findButton("连接 Telegram");
                  if (!weixinConnectButton || !telegramConnectButton) await new Promise((wait) => setTimeout(wait, 25));
                }
                if (!weixinConnectButton) throw new Error("WeChat settings UI is unavailable");
                if (!telegramConnectButton) throw new Error("Telegram settings UI is unavailable");
                if (typeof window.piBridge.setChannelCredential !== "function") {
                  throw new Error("Write-only channel credential bridge is unavailable");
                }
                const activityToggle = document.querySelector('[data-testid="channel-activity-toggle"]');
                if (!activityToggle || activityToggle.getAttribute("aria-expanded") !== "false") {
                  throw new Error("Recent channel activity is not collapsed by default");
                }
                activityToggle.click();
                await new Promise((wait) => setTimeout(wait, 0));
                if (activityToggle.getAttribute("aria-expanded") !== "true") {
                  throw new Error("Recent channel activity cannot be expanded");
                }
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
                  channelSettings: Boolean(weixinConnectButton && telegramConnectButton),
                  channelCredentialWrite: typeof window.piBridge.setChannelCredential === "function",
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
      `)) as {
        bridge?: boolean;
        rendered?: boolean;
        gitStatus?: boolean;
        htmlPreview?: boolean;
        channelSettings?: boolean;
        channelCredentialWrite?: boolean;
      };
      if (
        !rendererResult.bridge ||
        !rendererResult.rendered ||
        !rendererResult.gitStatus ||
        !rendererResult.htmlPreview ||
        !rendererResult.channelSettings ||
        !rendererResult.channelCredentialWrite
      ) {
        throw new Error(`Renderer smoke returned invalid result: ${JSON.stringify(rendererResult)}`);
      }
      if (rendererSecurityViolation) {
        throw new Error(`Renderer security violation: ${rendererSecurityViolation}`);
      }
    } finally {
      if (!smokeWindow.isDestroyed()) smokeWindow.destroy();
    }
    appendMainLog(
      `smoke: renderer/RPC/session/worktree/git/watch/download/skills/channels/toolchain revision=${acknowledgedRevision} checks passed`,
    );
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
