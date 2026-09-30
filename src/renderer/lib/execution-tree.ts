import type { ToolExecutionRecord } from "../../contract/executions";

export interface ExecutionTreeNode {
  record: ToolExecutionRecord;
  children: ExecutionTreeNode[];
}

/** Join calls within one run, preserving each child's independent terminal state. */
export function buildExecutionTree(records: readonly ToolExecutionRecord[]): ExecutionTreeNode[] {
  const latest = new Map<string, ToolExecutionRecord>();
  for (const record of records) {
    const previous = latest.get(record.executionId);
    if (!previous || record.sequence > previous.sequence) latest.set(record.executionId, record);
  }
  const nodes = [...latest.values()]
    .sort((a, b) => a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    .map((record) => ({ record, children: [] as ExecutionTreeNode[] }));
  const calls = new Map(nodes.map((node) => [`${node.record.runId}:${node.record.toolCallId}`, node]));
  const roots: ExecutionTreeNode[] = [];
  for (const node of nodes) {
    const parent = node.record.parentToolCallId
      ? calls.get(`${node.record.runId}:${node.record.parentToolCallId}`)
      : undefined;
    let ancestor = parent;
    const visited = new Set([node.record.executionId]);
    while (ancestor && !visited.has(ancestor.record.executionId)) {
      visited.add(ancestor.record.executionId);
      ancestor = ancestor.record.parentToolCallId
        ? calls.get(`${ancestor.record.runId}:${ancestor.record.parentToolCallId}`)
        : undefined;
    }
    if (!parent || ancestor) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}
