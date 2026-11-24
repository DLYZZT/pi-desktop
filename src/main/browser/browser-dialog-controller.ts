import type { BrowserHandoffDialog, BrowserHandoffResolution } from "../../contract/browser.ts";
import type { BrowserCdpCoordinator, BrowserCdpEvent } from "./browser-cdp-coordinator.ts";

export interface BrowserDialogContext {
  sessionId: string;
  origin: string;
  title: string;
}

export interface BrowserDialogControllerOptions {
  cdp: BrowserCdpCoordinator;
  getContext: (tabId: string) => BrowserDialogContext | undefined;
  requestHandoff: (input: {
    tabId: string;
    sessionId: string;
    kind: "dialog";
    origin: string;
    title: string;
    message: string;
    dialog: BrowserHandoffDialog;
    timeoutMs?: number;
  }) => Promise<BrowserHandoffResolution>;
  timeoutMs?: number;
  /** Keep Page enabled briefly after an action so async dialogs are still caught. */
  graceMs?: number;
}

type Attachment = {
  releaseDomain: () => Promise<void>;
  unsubscribe: () => void;
  releaseKeep: () => void;
  actionDepth: number;
  openDialogs: number;
  detachTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Intercepts page JavaScript dialogs through the CDP Page domain. The domain is
 * attached only around Agent actions (plus a short grace period), so an idle
 * Agent does not hold a debugger or trip the "no advanced CDP attached"
 * invariants after a revoke.
 */
export class BrowserDialogController {
  private readonly options: BrowserDialogControllerOptions;
  private readonly attachments = new Map<string, Attachment>();
  private readonly handling = new Set<string>();

  constructor(options: BrowserDialogControllerOptions) {
    this.options = options;
  }

  async beginAction(tabId: string): Promise<void> {
    let attachment = this.attachments.get(tabId);
    if (!attachment) {
      const releaseKeep = this.options.cdp.keepAttached(tabId, "dialogs");
      const unsubscribe = this.options.cdp.subscribe(tabId, (event) => {
        if (event.method === "Page.javascriptDialogOpening") void this.handle(tabId, event);
      });
      try {
        const releaseDomain = await this.options.cdp.enableDomain(tabId, "Page");
        attachment = { releaseDomain, unsubscribe, releaseKeep, actionDepth: 0, openDialogs: 0 };
        this.attachments.set(tabId, attachment);
      } catch (error) {
        unsubscribe();
        releaseKeep();
        throw error;
      }
    }
    if (attachment.detachTimer) {
      clearTimeout(attachment.detachTimer);
      attachment.detachTimer = undefined;
    }
    attachment.actionDepth += 1;
  }

  endAction(tabId: string): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    attachment.actionDepth = Math.max(0, attachment.actionDepth - 1);
    this.scheduleDetach(tabId, attachment);
  }

  detach(tabId: string): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    this.attachments.delete(tabId);
    this.handling.delete(tabId);
    if (attachment.detachTimer) clearTimeout(attachment.detachTimer);
    attachment.unsubscribe();
    void attachment.releaseDomain().catch(() => undefined);
    attachment.releaseKeep();
  }

  detachAll(): void {
    for (const tabId of [...this.attachments.keys()]) this.detach(tabId);
  }

  private scheduleDetach(tabId: string, attachment: Attachment): void {
    if (attachment.actionDepth > 0 || attachment.openDialogs > 0 || attachment.detachTimer) return;
    attachment.detachTimer = setTimeout(() => {
      attachment.detachTimer = undefined;
      if (attachment.actionDepth === 0 && attachment.openDialogs === 0) this.detach(tabId);
    }, this.options.graceMs ?? 1_500);
  }

  private async handle(tabId: string, event: BrowserCdpEvent): Promise<void> {
    const attachment = this.attachments.get(tabId);
    if (!attachment || this.handling.has(tabId)) return;
    this.handling.add(tabId);
    attachment.openDialogs += 1;
    try {
      const params = event.params ?? {};
      const type = normalizeDialogType(params.type);
      const message = typeof params.message === "string" ? params.message.slice(0, 2_000) : "";
      if (type === "alert" || type === "beforeunload") {
        await this.resolve(tabId, { accept: true });
        return;
      }
      const context = this.options.getContext(tabId);
      if (!context) {
        // The user owns this tab or it is already closing. Dismiss rather than
        // leaving a blocked renderer behind.
        await this.resolve(tabId, { accept: false });
        return;
      }
      const dialog: BrowserHandoffDialog = {
        type,
        ...(typeof params.defaultPrompt === "string" && params.defaultPrompt
          ? { defaultPrompt: params.defaultPrompt.slice(0, 4_096) }
          : {}),
      };
      let resolution: BrowserHandoffResolution | undefined;
      try {
        resolution = await this.options.requestHandoff({
          tabId,
          sessionId: context.sessionId,
          kind: "dialog",
          origin: context.origin,
          title: context.title,
          message: message || `The page opened a ${type} dialog.`,
          dialog,
          ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        });
      } catch {
        resolution = undefined;
      }
      const accept = resolution?.accept ?? resolution?.outcome === "completed";
      await this.resolve(tabId, {
        accept,
        ...(accept && resolution?.promptText !== undefined ? { promptText: resolution.promptText } : {}),
      });
    } finally {
      attachment.openDialogs = Math.max(0, attachment.openDialogs - 1);
      this.handling.delete(tabId);
      this.scheduleDetach(tabId, attachment);
    }
  }

  private async resolve(tabId: string, input: { accept: boolean; promptText?: string }): Promise<void> {
    try {
      await this.options.cdp.sendCommand(tabId, "Page.handleJavaScriptDialog", input);
    } catch {
      // The tab may have navigated, crashed, or closed while the user decided.
    }
  }
}

function normalizeDialogType(value: unknown): BrowserHandoffDialog["type"] {
  return value === "confirm" || value === "prompt" || value === "beforeunload" ? value : "alert";
}
