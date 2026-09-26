import { randomUUID } from "node:crypto";
import type { WebContents, WebFrameMain } from "electron";
import type {
  BrowserPageSnapshot,
  BrowserSnapshotNode,
  BrowserTabInfo,
  BrowserTabSummary,
} from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";
import { redactBrowserUrl } from "./browser-redaction.ts";
import { withTimeout } from "./browser-action-timing.ts";
import { createSnapshotScript } from "./browser-dom-scripts.ts";

export type SnapshotState = {
  id: string;
  generation: number;
  refs: Set<string>;
  nodes: Map<string, BrowserSnapshotNode>;
  frames: Map<string, { frame: WebFrameMain; offsetX: number; offsetY: number }>;
};

export type SnapshotTruncation = {
  text: boolean;
  nodes: boolean;
};

export type CapturedSnapshot = {
  snapshot: BrowserPageSnapshot;
  truncated: SnapshotTruncation;
};

interface SnapshotTarget {
  contents: Pick<WebContents, "mainFrame">;
  info: () => Readonly<Pick<BrowserTabInfo, "id" | "generation" | "url" | "title">>;
  timeoutMs: () => number;
}

export async function collectBrowserSnapshot(
  target: SnapshotTarget,
  maxNodes: number,
  maxTextChars: number,
  signal: AbortSignal,
): Promise<CapturedSnapshot & { state: SnapshotState }> {
  const snapshotId = randomUUID();
  const generation = target.info().generation;
  const contexts = await collectFrameContexts(target.contents);
  const nodes: BrowserSnapshotNode[] = [];
  const textParts: string[] = [];
  const frameRefs = new Map<string, { frame: WebFrameMain; offsetX: number; offsetY: number }>();
  let textLength = 0;
  let textTruncated = false;
  let nodesTruncated = false;
  for (const [frameIndex, context] of contexts.entries()) {
    if (nodes.length >= maxNodes || textLength >= maxTextChars) {
      // At least this frame remains unread, so either limit may have hidden
      // additional page text or interactive nodes.
      nodesTruncated = true;
      textTruncated = true;
      break;
    }
    const remainingNodes = maxNodes - nodes.length;
    const remainingText = maxTextChars - textLength;
    let result: unknown;
    try {
      result = await withTimeout(
        context.frame.executeJavaScript(createSnapshotScript(snapshotId, remainingNodes, remainingText, nodes.length)),
        target.timeoutMs(),
        "ACTION_TIMEOUT",
        signal,
      );
    } catch {
      continue;
    }
    const parsed = validateSnapshotResult(result);
    const frameId = `f${frameIndex}`;
    for (const node of parsed.nodes) {
      const adjusted: BrowserSnapshotNode = {
        ...node,
        frameId,
        frameUrl: redactBrowserUrl(context.frame.url),
        ...(node.bounds
          ? {
              bounds: {
                x: node.bounds.x + context.offsetX,
                y: node.bounds.y + context.offsetY,
                width: node.bounds.width,
                height: node.bounds.height,
              },
            }
          : {}),
      };
      nodes.push(adjusted);
      frameRefs.set(node.ref, context);
    }
    if (parsed.text) {
      textParts.push(parsed.text);
      textLength += parsed.text.length + 1;
    }
    textTruncated ||= parsed.textTruncated;
    nodesTruncated ||= parsed.nodesTruncated;
  }
  if (target.info().generation !== generation) {
    throw new BrowserError("INSPECTION_STALE", "Browser page changed while collecting a snapshot", {
      details: { reason: "generation-changed" },
    });
  }
  const state: SnapshotState = {
    id: snapshotId,
    generation,
    refs: new Set(nodes.map((node) => node.ref)),
    nodes: new Map(nodes.map((node) => [node.ref, node])),
    frames: frameRefs,
  };
  return {
    state,
    snapshot: {
      tabId: target.info().id,
      snapshotId,
      generation,
      url: redactBrowserUrl(target.info().url),
      title: target.info().title,
      text: textParts.join("\n").slice(0, maxTextChars),
      nodes,
      truncated: textTruncated || nodesTruncated,
      untrustedWebContent: true,
    },
    truncated: {
      text: textTruncated,
      nodes: nodesTruncated,
    },
  };
}

async function collectFrameContexts(
  contents: Pick<WebContents, "mainFrame">,
): Promise<Array<{ frame: WebFrameMain; offsetX: number; offsetY: number }>> {
  const result: Array<{ frame: WebFrameMain; offsetX: number; offsetY: number }> = [];
  const visit = async (frame: WebFrameMain, offsetX: number, offsetY: number): Promise<void> => {
    result.push({ frame, offsetX, offsetY });
    const children = frame.frames;
    if (!children.length) return;
    let rects: Array<{ x: number; y: number }> = [];
    try {
      const value =
        await frame.executeJavaScript(`Array.from(document.querySelectorAll('iframe,frame')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      })`);
      if (Array.isArray(value)) {
        rects = value.filter((entry): entry is { x: number; y: number } =>
          Boolean(
            entry &&
            typeof entry === "object" &&
            Number.isFinite((entry as { x?: unknown }).x) &&
            Number.isFinite((entry as { y?: unknown }).y),
          ),
        );
      }
    } catch {
      // A destroyed or provisional frame is omitted from the current snapshot.
    }
    for (const [index, child] of children.entries()) {
      const rect = rects[index] ?? { x: 0, y: 0 };
      await visit(child, offsetX + rect.x, offsetY + rect.y);
    }
  };
  await visit(contents.mainFrame, 0, 0);
  return result;
}

function validateSnapshotResult(value: unknown): {
  text: string;
  nodes: BrowserSnapshotNode[];
  textTruncated: boolean;
  nodesTruncated: boolean;
} {
  if (!value || typeof value !== "object")
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Invalid Browser snapshot result");
  const result = value as {
    text?: unknown;
    nodes?: unknown;
    textTruncated?: unknown;
    nodesTruncated?: unknown;
  };
  if (typeof result.text !== "string" || !Array.isArray(result.nodes)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Invalid Browser snapshot result");
  }
  const nodes = result.nodes.filter((node): node is BrowserSnapshotNode => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as Partial<BrowserSnapshotNode>;
    return (
      typeof candidate.ref === "string" && typeof candidate.role === "string" && typeof candidate.name === "string"
    );
  });
  return {
    text: result.text,
    nodes,
    textTruncated: result.textTruncated === true,
    nodesTruncated: result.nodesTruncated === true,
  };
}

export function tabSummary(tab: BrowserTabInfo): BrowserTabSummary {
  return {
    id: tab.id,
    profileId: tab.profileId,
    url: redactBrowserUrl(tab.url),
    title: tab.title.slice(0, 512),
    generation: tab.generation,
    loading: tab.loading,
    crashed: tab.crashed,
    visible: tab.visible,
  };
}

export function boundInspectionSnapshot(
  snapshot: BrowserPageSnapshot,
  maxNodeChars: number,
): { snapshot: BrowserPageSnapshot; nodesTruncated: boolean } {
  const nodes: BrowserSnapshotNode[] = [];
  let usedChars = 0;
  for (const node of snapshot.nodes) {
    const bounded: BrowserSnapshotNode = {
      ...node,
      name: node.name.slice(0, 300),
      ...(node.value === undefined ? {} : { value: node.value.slice(0, 500) }),
      ...(node.description === undefined ? {} : { description: node.description.slice(0, 300) }),
      ...(node.frameUrl === undefined ? {} : { frameUrl: redactBrowserUrl(node.frameUrl, 2_048) }),
    };
    const size = JSON.stringify(bounded).length;
    if (usedChars + size > maxNodeChars) break;
    nodes.push(bounded);
    usedChars += size;
  }
  const nodesTruncated = nodes.length !== snapshot.nodes.length;
  return {
    snapshot: {
      ...snapshot,
      nodes,
      truncated: snapshot.truncated || nodesTruncated,
    },
    nodesTruncated,
  };
}
