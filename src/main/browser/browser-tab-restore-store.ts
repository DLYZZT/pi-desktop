import fs from "node:fs";
import path from "node:path";
import type { BrowserRestoreTabRecord } from "../../contract/browser.ts";

const VERSION = 1 as const;
const MAX_FILE_BYTES = 256 * 1024;

export class BrowserTabRestoreStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): BrowserRestoreTabRecord[] {
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        version?: unknown;
        tabs?: unknown;
      };
      if (value.version !== VERSION || !Array.isArray(value.tabs)) return [];
      return value.tabs.slice(0, 64).flatMap((entry, index) => {
        if (!entry || typeof entry !== "object") return [];
        const tab = entry as Partial<BrowserRestoreTabRecord>;
        if (
          typeof tab.profileId !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(tab.profileId) ||
          typeof tab.url !== "string" ||
          !isRestorableUrl(tab.url) ||
          (tab.ownerSessionId !== null && typeof tab.ownerSessionId !== "string")
        ) {
          return [];
        }
        return [{ profileId: tab.profileId, url: tab.url, ownerSessionId: tab.ownerSessionId, order: index }];
      });
    } catch {
      return [];
    }
  }

  write(tabs: BrowserRestoreTabRecord[]): void {
    const safeTabs = tabs.filter((tab) => isRestorableUrl(tab.url)).slice(0, 64);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, tabs: safeTabs }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Best effort on Windows.
      }
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best effort cleanup.
      }
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Best effort.
    }
  }
}

function isRestorableUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
