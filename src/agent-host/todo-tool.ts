/**
 * The model-facing `todo_write` tool: a whole-list plan the user watches while
 * the agent works.
 *
 * Write-whole-list beats add/toggle: it is idempotent, the model never has to
 * remember item ids, and a repeated write cannot drift from what is on screen.
 * The list lives in the tool result's `details`, so the panel state follows the
 * branch (see todo-plan.ts) and no extra storage or protocol is involved.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TodoItem } from "./todo-plan.ts";
import { MAX_TODO_CONTENT_LENGTH, MAX_TODO_ITEMS, readTodoItems } from "./todo-plan.ts";

export const TODO_WRITE_TOOL_NAME = "todo_write";

export interface TodoWriteDetails {
  todos: TodoItem[];
}

const TodoItemSchema = Type.Object({
  content: Type.String({
    maxLength: MAX_TODO_CONTENT_LENGTH,
    description: "Imperative one-line description of the step, for example “Add the retry wrapper”",
  }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
    description: "pending = not started, in_progress = working on it now, completed = done and verified",
  }),
});

/** `- [x] done` / `- [~] now` / `- [ ] later`: one line per item, no decoration. */
export function formatTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "Plan cleared.";
  const mark = (status: TodoItem["status"]) =>
    status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
  const done = items.filter((item) => item.status === "completed").length;
  return [
    `Plan (${done}/${items.length} completed):`,
    ...items.map((item) => `- ${mark(item.status)} ${item.content}`),
  ].join("\n");
}

export function createTodoWriteTool() {
  return defineTool({
    name: TODO_WRITE_TOOL_NAME,
    label: "Plan",
    description:
      "Record or update the plan for the current task as a whole list. Call it with the complete list every time: items you omit are dropped, and an empty list clears the plan. Use it for multi-step work the user should be able to follow.",
    promptSnippet: "Track a multi-step plan the user can watch",
    promptGuidelines: [
      "Use todo_write only for work with several distinct steps the user should see progressing; do not turn a single edit into a checklist.",
      "Mark exactly one item in_progress before starting it, and set it to completed once verified — not when merely attempted.",
      "Send the full list on every call; never send only the changed item.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      todos: Type.Array(TodoItemSchema, {
        maxItems: MAX_TODO_ITEMS,
        description: "The complete plan, in execution order. Empty clears the plan.",
      }),
    }),
    async execute(_toolCallId, params) {
      let items: TodoItem[];
      try {
        items = readTodoItems(params.todos);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return {
        content: [{ type: "text" as const, text: formatTodoList(items) }],
        details: { todos: items } satisfies TodoWriteDetails,
      };
    },
  });
}
