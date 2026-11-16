/**
 * Plan (todo) state derived from the current branch.
 *
 * The source of truth is the newest successful `todo_write` tool result on the
 * branch — not a snapshot the renderer keeps. Two reasons:
 * - History pages retain only the newest turns and compaction drops entries
 *   from the model context, so a renderer scanning messages would lose the plan
 *   while the transcript still shows one.
 * - `SessionManager.getBranch()` returns the raw branch *including* entries
 *   compaction summarized away, so scanning it stays correct; and because it
 *   walks parent links from the current leaf, switching branches makes the plan
 *   automatically follow that branch's last write.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, TodoPlanState } from "../shared/types.ts";

export const TODO_WRITE_TOOL_NAME = "todo_write";

export type TodoStatus = TodoPlanState["items"][number]["status"];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export type TodoPlan = TodoPlanState;

export const MAX_TODO_ITEMS = 20;
export const MAX_TODO_CONTENT_LENGTH = 500;

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/** Normalizes model-supplied items; throws on anything unusable. */
export function readTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) throw new Error("todos must be an array of {content, status} objects");
  if (value.length > MAX_TODO_ITEMS) throw new Error(`todos must contain at most ${MAX_TODO_ITEMS} items`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`todos[${index}] must be an object`);
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !content.trim())
      throw new Error(`todos[${index}].content must be a non-empty string`);
    if (!isTodoStatus(status)) throw new Error(`todos[${index}].status must be pending, in_progress or completed`);
    return { content: content.trim().slice(0, MAX_TODO_CONTENT_LENGTH), status };
  });
}

/** `null` means "no plan" — an empty write clears the panel. */
export function summarizeTodoItems(items: TodoItem[]): TodoPlan | null {
  if (items.length === 0) return null;
  return { items, completed: items.filter((item) => item.status === "completed").length };
}

function planFromDetails(details: unknown): TodoPlan | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const raw = (details as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !isTodoStatus(status)) return null;
    items.push({ content, status });
  }
  return summarizeTodoItems(items);
}

/**
 * The plan this branch currently shows: the newest successful write wins, and
 * an empty write clears it. `null` means the panel stays hidden.
 */
export function readTodoPlan(path: readonly SessionEntry[]): TodoPlan | null {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    if (message.toolName !== TODO_WRITE_TOOL_NAME || message.isError) continue;
    return planFromDetails(message.details);
  }
  return null;
}

/** Branch-scoped read for callers holding a session manager. */
export function readSessionTodoPlan(manager: Pick<SessionManager, "getBranch">): TodoPlan | null {
  return readTodoPlan(manager.getBranch() as SessionEntry[]);
}
