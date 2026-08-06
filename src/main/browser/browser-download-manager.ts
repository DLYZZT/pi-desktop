import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadItem, Session, WebContents } from "electron";
import type { BrowserDownloadInfo, BrowserDownloadSettings, BrowserEvent } from "../../contract/browser.ts";

type ActiveDownload = {
  info: BrowserDownloadInfo;
  item: DownloadItem;
};

const MAX_RETAINED_DOWNLOADS = 100;

export interface BrowserDownloadManagerOptions {
  session: Session;
  getSettings: () => BrowserDownloadSettings;
  getTabForWebContents: (id: number) => { tabId: string; sessionId?: string } | undefined;
  chooseSavePath: (filename: string) => Promise<string | null>;
  emit: (event: BrowserEvent) => void;
}

export class BrowserDownloadManager {
  private readonly options: BrowserDownloadManagerOptions;
  private readonly downloads = new Map<string, ActiveDownload>();
  private disposed = false;

  constructor(options: BrowserDownloadManagerOptions) {
    this.options = options;
    options.session.on("will-download", this.handleDownload);
  }

  list(): BrowserDownloadInfo[] {
    return [...this.downloads.values()].map(({ info }) => structuredClone(info));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.session.removeListener("will-download", this.handleDownload);
    for (const active of this.downloads.values()) {
      if (active.item.getState() === "progressing" || active.item.canResume()) active.item.cancel();
    }
    this.downloads.clear();
  }

  private readonly handleDownload = (event: Electron.Event, item: DownloadItem, webContents: WebContents): void => {
    const settings = this.options.getSettings();
    if (this.disposed || settings.mode === "deny") {
      event.preventDefault();
      return;
    }
    const id = randomUUID();
    const tab = this.options.getTabForWebContents(webContents.id);
    const filename = sanitizeDownloadFilename(item.getFilename());
    const info: BrowserDownloadInfo = {
      id,
      ...(tab?.tabId ? { tabId: tab.tabId } : {}),
      ...(tab?.sessionId ? { sessionId: tab.sessionId } : {}),
      url: safeDownloadUrl(item.getURL()),
      filename,
      state: "pending",
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
    };
    this.downloads.set(id, { info, item });
    this.emit(info);

    item.on("updated", (_downloadEvent, state) => {
      info.state = state === "interrupted" ? "interrupted" : "progressing";
      info.receivedBytes = Math.max(0, item.getReceivedBytes());
      info.totalBytes = Math.max(0, item.getTotalBytes());
      this.emit(info);
    });
    item.once("done", (_downloadEvent, state) => {
      info.state = state;
      info.receivedBytes = Math.max(0, item.getReceivedBytes());
      info.totalBytes = Math.max(0, item.getTotalBytes());
      this.emit(info);
      this.pruneCompleted();
    });

    if (settings.mode === "allow-to-directory" && settings.directory) {
      const savePath = safeDownloadPath(settings.directory, filename);
      info.savePath = savePath;
      item.setSavePath(savePath);
      info.state = "progressing";
      this.emit(info);
      return;
    }

    item.pause();
    void this.options
      .chooseSavePath(filename)
      .then((savePath) => {
        if (this.disposed || (item.getState() !== "progressing" && !item.canResume())) return;
        if (!savePath) {
          item.cancel();
          return;
        }
        info.savePath = savePath;
        info.state = "progressing";
        item.setSavePath(savePath);
        item.resume();
        this.emit(info);
      })
      .catch(() => item.cancel());
  };

  private pruneCompleted(): void {
    if (this.downloads.size <= MAX_RETAINED_DOWNLOADS) return;
    for (const [id, download] of this.downloads) {
      if (download.info.state === "pending" || download.info.state === "progressing") continue;
      this.downloads.delete(id);
      if (this.downloads.size <= MAX_RETAINED_DOWNLOADS) break;
    }
  }

  private emit(info: BrowserDownloadInfo): void {
    this.options.emit({ type: "download", download: structuredClone(info) });
  }
}

export function sanitizeDownloadFilename(value: string): string {
  const basename = path.basename(typeof value === "string" ? value : "download");
  const cleaned = basename
    .replace(/[\0-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return cleaned.slice(0, 240) || "download";
}

export function safeDownloadPath(directory: string, filename: string): string {
  const root = path.resolve(directory);
  const target = path.resolve(root, sanitizeDownloadFilename(filename));
  if (path.dirname(target) !== root) throw new Error("Download path escaped configured directory");
  return target;
}

function safeDownloadUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().slice(0, 8_192);
  } catch {
    return "";
  }
}
