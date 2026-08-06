import fs from "node:fs";
import path from "node:path";
import type { BrowserSettingsPatch, BrowserSettingsV2 } from "../../contract/browser.ts";
import {
  applyBrowserSettingsPatch,
  createDefaultBrowserSettings,
  parseBrowserSettings,
  settingsForPersistence,
  validateBrowserSettings,
  type ParsedBrowserSettings,
} from "./browser-settings.ts";

const MAX_SETTINGS_BYTES = 256 * 1024;

export class BrowserSettingsStore {
  private loaded: ParsedBrowserSettings | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get(): ParsedBrowserSettings {
    if (!this.loaded) this.loaded = this.read();
    return structuredClone(this.loaded);
  }

  update(patch: BrowserSettingsPatch): ParsedBrowserSettings {
    const current = this.get();
    if (current.compatibilityReadOnly) {
      throw new Error("Browser settings were written by a newer Pi Desktop and are read-only");
    }
    const settings = applyBrowserSettingsPatch(current.settings, patch);
    const persisted = settingsForPersistence(settings);
    this.write(persisted);
    this.loaded = {
      settings,
      compatibilityReadOnly: false,
      recoveredFromInvalid: false,
    };
    return this.get();
  }

  replace(settings: BrowserSettingsV2): ParsedBrowserSettings {
    const current = this.get();
    if (current.compatibilityReadOnly) {
      throw new Error("Browser settings were written by a newer Pi Desktop and are read-only");
    }
    const next = validateBrowserSettings(settings);
    this.write(settingsForPersistence(next));
    this.loaded = { settings: next, compatibilityReadOnly: false, recoveredFromInvalid: false };
    return this.get();
  }

  reset(): ParsedBrowserSettings {
    const current = this.get();
    if (current.compatibilityReadOnly) {
      throw new Error("Browser settings were written by a newer Pi Desktop and are read-only");
    }
    const settings = createDefaultBrowserSettings();
    this.write(settings);
    this.loaded = { settings, compatibilityReadOnly: false, recoveredFromInvalid: false };
    return this.get();
  }

  reload(): ParsedBrowserSettings {
    this.loaded = this.read();
    return this.get();
  }

  private read(): ParsedBrowserSettings {
    try {
      const stats = fs.statSync(this.filePath);
      if (!stats.isFile() || stats.size > MAX_SETTINGS_BYTES) {
        return { settings: createDefaultBrowserSettings(), compatibilityReadOnly: false, recoveredFromInvalid: true };
      }
      return parseBrowserSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { settings: createDefaultBrowserSettings(), compatibilityReadOnly: false, recoveredFromInvalid: false };
      }
      return { settings: createDefaultBrowserSettings(), compatibilityReadOnly: false, recoveredFromInvalid: true };
    }
  }

  private write(settings: BrowserSettingsV2): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Windows has no POSIX mode; the containing userData directory remains per-user.
      }
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best effort cleanup after a failed atomic replace.
      }
    }
  }
}
