import type { SessionTreeNode } from "../shared/types";

export const MAX_PROJECTED_TREE_DEPTH = 200;

export type ProjectTreeNode = {
  entry: { id: string };
  children: ProjectTreeNode[];
  compressedEntryIds?: string[];
};

/**
 * Collapse linear runs while retaining roots, branch points, and leaves.
 * SessionManager is expected to return a strict tree; cycles and shared node
 * objects are rejected to keep projection deterministic.
 */
export function projectTreeForResponse<T extends ProjectTreeNode>(nodes: T[]): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) throw new Error("Project tree contains a cycle or shared node");
    seen.add(node);
    if (roots.has(node) || node.children.length !== 1) keep.add(node);
    for (const child of node.children) stack.push(child as T);
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => {
    const { children: _children, compressedEntryIds: _existingCompressedIds, ...rest } = node;
    return {
      ...rest,
      children: [],
      ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    } as unknown as T;
  };

  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;
    for (const sourceChild of source.children) {
      let child = sourceChild as T;
      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        projected.children.push(cloneNode(child));
        continue;
      }

      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0] as T;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

function treeEntryPreview(entry: Record<string, unknown>): SessionTreeNode["entry"] {
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  const message =
    entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>) : null;
  const role =
    message && ["user", "assistant", "toolResult", "custom"].includes(String(message.role))
      ? (message.role as SessionTreeNode["entry"]["role"])
      : undefined;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block) =>
              block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                ? [String((block as { text?: unknown }).text ?? "")]
                : [],
            )
            .join(" ")
        : "";
  const preview = text.trim().replace(/\s+/g, " ").slice(0, 80);
  return {
    id: String(entry.id),
    type,
    ...(role ? { role } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** Compress and strip message payloads; branch navigation only needs metadata previews. */
export function projectSessionTreeForResponse<T extends ProjectTreeNode>(nodes: T[]): SessionTreeNode[] {
  const projected = projectTreeForResponse(nodes);
  const convert = (node: T): SessionTreeNode => ({
    entry: treeEntryPreview(node.entry as Record<string, unknown>),
    children: node.children.map((child) => convert(child as T)),
    ...(node.compressedEntryIds?.length ? { compressedEntryIds: [...node.compressedEntryIds] } : {}),
  });
  return projected.map(convert);
}
