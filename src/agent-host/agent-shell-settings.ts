import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isAgentShell, type AgentShell, type AgentShellSettings } from "../shared/agent-shell.ts";
import { desktopDataRoot } from "./desktop-data-root.ts";

export class AgentShellPreferences {
  constructor(
    private readonly filePath: string,
    private readonly platform = process.platform,
  ) {}

  get(): AgentShellSettings {
    if (this.platform !== "win32") return { platform: this.platform, shell: "bash" };
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (value.version !== 1 || !isAgentShell(value.shell)) throw new Error("Invalid Agent shell settings");
      return { platform: this.platform, shell: value.shell };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { platform: this.platform, shell: "powershell" };
    }
  }

  set(shell: AgentShell): AgentShellSettings {
    if (this.platform !== "win32" || !isAgentShell(shell)) throw new Error("Invalid Agent shell selection");
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, shell }) + "\n", { mode: 0o600 });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        /* ignore cleanup failure */
      }
      throw error;
    }
    return this.get();
  }
}

export function agentShellPreferences(): AgentShellPreferences {
  return new AgentShellPreferences(path.join(desktopDataRoot(), "agent-shell.json"));
}
