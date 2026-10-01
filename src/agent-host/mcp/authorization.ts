import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiConfirmLocalization } from "../../shared/types";

interface PermissionTarget {
  servers: string[];
  tools: string[];
  identity: string;
}
export class McpAuthorizationRequests {
  private pending = new Map<string, { controller: AbortController; promise: Promise<boolean> }>();
  private denied = new Set<string>();
  reset(sessionId: string): void {
    for (const key of [...this.denied]) if (key.startsWith(sessionId + "\0")) this.denied.delete(key);
  }
  cancel(sessionId: string): void {
    for (const [key, entry] of this.pending) if (key.startsWith(sessionId + "\0")) entry.controller.abort();
    this.reset(sessionId);
  }
  request(sessionId: string, target: PermissionTarget, ctx: ExtensionContext, accept: () => boolean): Promise<boolean> {
    const key = sessionId + "\0" + target.servers.join("\0");
    if (this.denied.has(key)) return Promise.resolve(false);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = (async () => {
      const localization: ExtensionUiConfirmLocalization = {
        id: "mcp.authorize",
        servers: target.servers.join(", "),
        tools: target.tools.join("\n"),
        toolCount: target.tools.length,
      };
      const ui = ctx.ui as typeof ctx.ui & {
        confirmLocalized?: (
          title: string,
          message: string,
          copy: ExtensionUiConfirmLocalization,
          options: { timeout: number; signal: AbortSignal },
        ) => Promise<boolean>;
      };
      const title = "Allow MCP tools for this session?",
        message = `${localization.servers}\n\n${localization.tools}\n\nAllow this session to use these server tools? You can revoke access in MCP settings.`;
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const options = { timeout: 120000, signal };
      const approved = ui.confirmLocalized
        ? await ui.confirmLocalized(title, message, localization, options)
        : await ui.confirm(title, message, options);
      if (!approved || signal.aborted || !accept()) {
        this.denied.add(key);
        return false;
      }
      return true;
    })().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, { controller, promise });
    return promise;
  }
}
