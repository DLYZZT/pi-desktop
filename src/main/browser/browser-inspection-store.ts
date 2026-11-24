import { createHash, randomUUID } from "node:crypto";
import type { BrowserInspectionDelta, BrowserSnapshotNode } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

type NodeDigest = { ref: string; hash: string };

type InspectionRecord = {
  id: string;
  sessionId: string;
  tabId: string;
  generation: number;
  contentHash: string;
  viewportHash: string;
  nodeHashes: Map<string, NodeDigest>;
  textHash: string;
  createdAt: number;
};

export class BrowserInspectionStore {
  private readonly records = new Map<string, InspectionRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(now: () => number = Date.now, ttlMs = 10 * 60 * 1_000, maxRecords = 200) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
  }

  record(input: {
    sessionId: string;
    tabId: string;
    generation: number;
    contentHash: string;
    viewportHash: string;
    nodes?: BrowserSnapshotNode[];
    text?: string;
    sinceInspectionId?: string;
  }): { inspectionId: string; changed: boolean; delta?: BrowserInspectionDelta } {
    this.prune();
    let changed = true;
    let delta: BrowserInspectionDelta | undefined;
    const indexed = digestNodes(input.nodes ?? []);
    if (input.sinceInspectionId) {
      const prior = this.records.get(input.sinceInspectionId);
      if (!prior || prior.sessionId !== input.sessionId || prior.tabId !== input.tabId) {
        throw new BrowserError("INSPECTION_STALE", "Browser inspection id is stale or unavailable");
      }
      changed =
        prior.generation !== input.generation ||
        prior.contentHash !== input.contentHash ||
        prior.viewportHash !== input.viewportHash;
      if (changed) {
        delta = compareNodes(prior.nodeHashes, indexed, prior.textHash, hashText(input.text ?? ""));
      }
    }
    const inspectionId = randomUUID();
    this.records.set(inspectionId, {
      id: inspectionId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      generation: input.generation,
      contentHash: input.contentHash,
      viewportHash: input.viewportHash,
      nodeHashes: indexed.digests,
      textHash: hashText(input.text ?? ""),
      createdAt: this.now(),
    });
    this.prune();
    return { inspectionId, changed, ...(delta ? { delta } : {}) };
  }

  clearTab(tabId: string): void {
    for (const [id, record] of this.records) {
      if (record.tabId === tabId) this.records.delete(id);
    }
  }

  clearSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(id);
    }
  }

  clear(): void {
    this.records.clear();
  }

  size(): number {
    this.prune();
    return this.records.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.records) {
      if (record.createdAt < cutoff) this.records.delete(id);
    }
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }
}

type IndexedNodes = {
  digests: Map<string, NodeDigest>;
  byKey: Map<string, BrowserSnapshotNode>;
};

function digestNodes(items: BrowserSnapshotNode[]): IndexedNodes {
  const seen = new Map<string, number>();
  const digests = new Map<string, NodeDigest>();
  const byKey = new Map<string, BrowserSnapshotNode>();
  for (const node of items) {
    const base = `${node.frameId ?? ""}|${node.role}|${node.name}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const key = `${base}|${ordinal}`;
    digests.set(key, { ref: node.ref, hash: hashNode(node) });
    byKey.set(key, node);
  }
  return { digests, byKey };
}

function hashNode(node: BrowserSnapshotNode): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        value: node.value ?? null,
        checked: node.checked ?? null,
        disabled: node.disabled ?? null,
        level: node.level ?? null,
      }),
    )
    .digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareNodes(
  prior: Map<string, NodeDigest>,
  indexed: IndexedNodes,
  priorTextHash: string,
  nextTextHash: string,
): BrowserInspectionDelta {
  const added: BrowserSnapshotNode[] = [];
  const changed: BrowserSnapshotNode[] = [];
  const removed: Array<{ ref: string; key: string }> = [];
  for (const [key, digest] of indexed.digests) {
    const previous = prior.get(key);
    const node = indexed.byKey.get(key);
    if (!previous) {
      if (node) added.push(node);
    } else if (previous.hash !== digest.hash && node) {
      changed.push(node);
    }
  }
  for (const [key, digest] of prior) {
    if (!indexed.digests.has(key)) removed.push({ ref: digest.ref, key });
  }
  return { added, changed, removed, textChanged: priorTextHash !== nextTextHash };
}
