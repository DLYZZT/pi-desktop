import type { SessionTreeNode } from "@/lib/types";

export const MAX_BRANCH_GUIDE_DEPTH = 12;

export interface BranchTreeRow {
  key: string;
  node: SessionTreeNode;
  representative: SessionTreeNode;
  skipped: number;
  depth: number;
  isLast: boolean;
  guideLines: readonly boolean[];
}

export function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();

  const parents = new Map<string, string | null>();
  const visited = new Set<SessionTreeNode>();
  const stack = nodes
    .slice()
    .reverse()
    .map((node) => ({ node, parentId: null as string | null }));

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    parents.set(current.node.entry.id, current.parentId);

    if (current.node.entry.id === targetId || current.node.compressedEntryIds?.includes(targetId)) {
      const path = new Set<string>();
      let entryId: string | null = current.node.entry.id;
      while (entryId) {
        path.add(entryId);
        entryId = parents.get(entryId) ?? null;
      }
      return path;
    }

    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], parentId: current.node.entry.id });
    }
  }

  return new Set();
}

export function compressBranchNode(node: SessionTreeNode): { node: SessionTreeNode; skipped: number } {
  let current = node;
  let skipped = current.compressedEntryIds?.length ?? 0;
  const visited = new Set<SessionTreeNode>([current]);

  while (current.children.length === 1) {
    const child = current.children[0];
    if (visited.has(child)) break;
    visited.add(child);
    current = child;
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }

  return { node: current, skipped };
}

export function treeHasBranch(nodes: SessionTreeNode[]): boolean {
  const visited = new Set<SessionTreeNode>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.children.length > 1) return true;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }

  return false;
}

export function flattenBranchTree(nodes: SessionTreeNode[]): BranchTreeRow[] {
  const rows: BranchTreeRow[] = [];
  const visited = new Set<SessionTreeNode>();
  const stack: Array<{
    node: SessionTreeNode;
    depth: number;
    isLast: boolean;
    guideLines: readonly boolean[];
  }> = [];

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index], depth: 0, isLast: index === nodes.length - 1, guideLines: [] });
  }

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    const compressed = compressBranchNode(current.node);
    rows.push({
      key: current.node.entry.id,
      node: current.node,
      representative: compressed.node,
      skipped: compressed.skipped,
      depth: current.depth,
      isLast: current.isLast,
      guideLines: current.guideLines,
    });

    const children = compressed.node.children;
    const nextGuideLines =
      current.guideLines.length < MAX_BRANCH_GUIDE_DEPTH
        ? [...current.guideLines, !current.isLast]
        : current.guideLines;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        depth: current.depth + 1,
        isLast: index === children.length - 1,
        guideLines: nextGuideLines,
      });
    }
  }

  return rows;
}

export function shouldDismissBranchNavigator(
  event: Pick<Event, "type" | "target"> & { key?: string },
  root: HTMLElement,
): boolean {
  if (event.type === "keydown") return event.key === "Escape";
  return event.type === "pointerdown" && event.target !== null && !root.contains(event.target as Node);
}
