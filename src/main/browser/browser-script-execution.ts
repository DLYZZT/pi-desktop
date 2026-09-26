import type { WebContents } from "electron";
import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { redactBrowserText } from "./browser-redaction.ts";
import { withTimeout } from "./browser-action-timing.ts";
import { clampInteger } from "./browser-bounds.ts";

const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCRIPT_RESULT_BYTES = 2 * 1024 * 1024;
type ScriptCdp = Pick<BrowserCdpCoordinator, "acquire" | "sendCommand" | "isAttached">;
interface ScriptTarget {
  contents: Pick<WebContents, "isDestroyed">;
  tabId: string;
  timeoutMs: () => number;
}
export interface BrowserScriptOptions {
  timeoutMs?: number;
  world?: "main" | "isolated";
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

export function validateBrowserJavaScriptSource(source: string): void {
  if (typeof source !== "string" || !source || Buffer.byteLength(source) > MAX_SCRIPT_BYTES) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser JavaScript source is invalid");
  }
}
export function validateBrowserCdpParams(params?: Record<string, unknown>): void {
  const encodedParams = JSON.stringify(params ?? {});
  if (Buffer.byteLength(encodedParams) > MAX_SCRIPT_BYTES) {
    throw new BrowserError("RESULT_TOO_LARGE", "CDP command parameters are too large");
  }
}

export async function executeBrowserJavaScript(
  target: ScriptTarget,
  cdp: ScriptCdp,
  source: string,
  options: BrowserScriptOptions,
  signal: AbortSignal,
): Promise<{ value?: unknown; exception?: string; untrustedWebContent: true }> {
  const { tabId } = target;

  const contents = target.contents;
  const releaseDebugger = cdp.acquire(tabId);
  let remoteObjectId: string | undefined;
  let terminateExecution = false;
  try {
    let contextId: number | undefined;
    if (options.world === "isolated") {
      const tree = await cdp.sendCommand<{
        frameTree?: { frame?: { id?: string } };
      }>(tabId, "Page.getFrameTree");
      const frameId = tree.frameTree?.frame?.id;
      if (!frameId) throw new BrowserError("JAVASCRIPT_TIMEOUT", "Browser main frame is unavailable");
      const isolated = await cdp.sendCommand<{ executionContextId?: number }>(tabId, "Page.createIsolatedWorld", {
        frameId,
        worldName: "pi-browser-tools",
        grantUniveralAccess: false,
      });
      contextId = isolated.executionContextId;
    }
    const evaluated = (await withTimeout(
      cdp.sendCommand(tabId, "Runtime.evaluate", {
        expression: source,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: options.returnByValue !== false,
        userGesture: true,
        ...(contextId === undefined ? {} : { contextId }),
      }),
      clampInteger(options.timeoutMs ?? target.timeoutMs(), 50, 120_000),
      "JAVASCRIPT_TIMEOUT",
      signal,
    )) as {
      result?: {
        value?: unknown;
        objectId?: string;
        type?: string;
        subtype?: string;
        description?: string;
        unserializableValue?: string;
      };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    remoteObjectId = evaluated.result?.objectId;
    if (evaluated.exceptionDetails) {
      const exception = redactBrowserText(
        evaluated.exceptionDetails.exception?.description ??
          evaluated.exceptionDetails.text ??
          "JavaScript execution failed",
        4_096,
      );
      throw new BrowserError("JAVASCRIPT_EXECUTION_FAILED", `Browser JavaScript failed: ${exception}`, {
        details: { exception },
      });
    }
    const value =
      options.returnByValue === false
        ? {
            type: evaluated.result?.type,
            subtype: evaluated.result?.subtype,
            description: evaluated.result?.description,
            unserializableValue: evaluated.result?.unserializableValue,
          }
        : evaluated.result?.value;
    const serialized = JSON.stringify(value);
    if (serialized && Buffer.byteLength(serialized) > MAX_SCRIPT_RESULT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "Browser JavaScript result is too large");
    }
    return { value: sanitizeSerializable(value), untrustedWebContent: true };
  } catch (error) {
    if (error instanceof BrowserError) {
      terminateExecution = error.code === "JAVASCRIPT_TIMEOUT" || error.code === "USER_TOOK_CONTROL";
      throw error;
    }
    const exception = redactBrowserText(error instanceof Error ? error.message : "JavaScript execution failed", 4_096);
    throw new BrowserError("JAVASCRIPT_EXECUTION_FAILED", `Browser JavaScript failed: ${exception}`, {
      details: { exception },
      cause: error,
    });
  } finally {
    if (!contents.isDestroyed() && remoteObjectId && cdp.isAttached(tabId)) {
      await cdp.sendCommand(tabId, "Runtime.releaseObject", { objectId: remoteObjectId }).catch(() => undefined);
    }
    if (!contents.isDestroyed() && (terminateExecution || signal.aborted) && cdp.isAttached(tabId)) {
      await withTimeout(cdp.sendCommand(tabId, "Runtime.terminateExecution"), 1_000, "JAVASCRIPT_TIMEOUT").catch(
        () => undefined,
      );
    }
    releaseDebugger();
  }
}

export async function sendBrowserCdpCommand(
  cdp: Pick<ScriptCdp, "acquire" | "sendCommand">,
  tabId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const releaseDebugger = cdp.acquire(tabId, "raw-cdp");
  try {
    const result = await cdp.sendCommand(tabId, method, params);
    const encoded = JSON.stringify(result);
    const objectIds = collectRemoteObjectIds(result);
    for (const objectId of objectIds) {
      await cdp.sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
    if (encoded && Buffer.byteLength(encoded) > MAX_SCRIPT_RESULT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "CDP command result is too large");
    }
    return encoded
      ? (JSON.parse(encoded, (key, value) => (key === "objectId" ? "<released>" : value)) as unknown)
      : undefined;
  } finally {
    releaseDebugger();
  }
}

function sanitizeSerializable(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value).slice(0, 4_096);
  }
}

function collectRemoteObjectIds(value: unknown): string[] {
  const objectIds = new Set<string>();
  const visit = (candidate: unknown, depth: number): void => {
    if (!candidate || typeof candidate !== "object" || depth > 32 || objectIds.size >= 1_000) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "objectId" && typeof entry === "string" && entry.length <= 4_096) objectIds.add(entry);
      else visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return [...objectIds];
}
