/**
 * `/goal` mode: the user states a goal once, and the agent keeps working —
 * across turns — until it reports every acceptance criterion as met with
 * evidence, or the continuation budget runs out. The user accepts, sends the
 * goal back with feedback, adds budget, or stops from the goal panel.
 *
 * The orchestration is a single inline extension: it registers the `/goal`
 * command and the `goal_report` tool, refreshes the prompt block, and uses the
 * `turn_end` boundary to continue the run. Boundaries need a model-visible
 * entry to continue, so each continuation appends a `custom_message` alongside
 * the counted `custom` entry.
 */
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type InlineExtension,
  type SessionBoundaryDraft,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalReportState, GoalState } from "../shared/types";
import type { SessionPromptPolicy } from "./session-prompt-policy";
import {
  CHECKPOINT_EVERY,
  DEFAULT_MAX_CONTINUATIONS,
  GOAL_CONTINUATION_TYPE,
  GOAL_CUSTOM_TYPE,
  GOAL_REPORT_TOOL_NAME,
  MAX_GOAL_CRITERIA,
  MAX_GOAL_CRITERION_LENGTH,
  MAX_GOAL_EVIDENCE_LENGTH,
  MAX_GOAL_LENGTH,
  readSessionGoalState,
  syncGoalPromptSection,
  type GoalEntry,
} from "./goal-state";

export const GOAL_COMMAND_NAME = "goal";

export interface GoalTurnDecision {
  entries: SessionBoundaryDraft[];
  continue: boolean;
}

function parseCriteria(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_GOAL_CRITERIA)
    .map((line) => line.slice(0, MAX_GOAL_CRITERION_LENGTH));
}

async function askAcceptanceCriteria(ctx: ExtensionCommandContext): Promise<string[]> {
  if (!ctx.hasUI) return [];
  try {
    const typed = await ctx.ui.editor("Acceptance criteria (optional, one per line)", "");
    return parseCriteria(typed);
  } catch {
    // A cancelled or timed-out dialog must not block starting the goal.
    return [];
  }
}

function notifyGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else pi.sendMessage({ customType: "pi-desktop-goal-notice", content: message, display: true });
}

function goalStartMessage(goal: string, criteria: readonly string[]): string {
  return [
    "Goal mode is on. Work autonomously toward this goal until it is verified.",
    "",
    `Goal: ${goal}`,
    criteria.length
      ? ["Acceptance criteria:", ...criteria.map((criterion) => `- ${criterion}`)].join("\n")
      : "Acceptance criteria: none supplied — propose concrete, user-verifiable criteria in your first reply.",
    "",
    "First restate the goal and criteria, then write the plan with todo_write and begin working.",
  ].join("\n");
}

async function startGoal(
  pi: ExtensionAPI,
  prompt: SessionPromptPolicy,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const goal = args.trim();
  if (!goal) {
    notifyGoal(pi, ctx, "Usage: /goal <goal and acceptance criteria>");
    return;
  }
  if (!ctx.isIdle()) {
    notifyGoal(pi, ctx, "Stop the current turn before starting a goal.");
    return;
  }
  const criteria = await askAcceptanceCriteria(ctx);
  pi.appendEntry(GOAL_CUSTOM_TYPE, {
    kind: "start",
    goal: goal.slice(0, MAX_GOAL_LENGTH),
    criteria,
    maxContinuations: DEFAULT_MAX_CONTINUATIONS,
    checkpointEvery: CHECKPOINT_EVERY,
  } satisfies GoalEntry);
  syncGoalPromptSection(prompt, ctx.sessionManager);
  // Extension commands own their LLM interaction; this starts the first turn.
  pi.sendUserMessage(goalStartMessage(goal, criteria));
}

/**
 * The decision for one completed turn. `null` settles the run: the goal is
 * waiting for the user, already decided, or not active.
 */
export function decideGoalTurnEnd(
  state: GoalState,
  previousEntries: readonly SessionBoundaryDraft[] = [],
): GoalTurnDecision | null {
  if (state.status !== "working") return null;
  if (state.continuations >= state.maxContinuations) {
    return {
      entries: [
        ...previousEntries,
        { type: "custom", customType: GOAL_CUSTOM_TYPE, data: { kind: "budget_exhausted" } satisfies GoalEntry },
        {
          type: "custom_message",
          customType: GOAL_CONTINUATION_TYPE,
          display: false,
          content:
            "The goal's auto-continuation budget is exhausted. Do not continue working. Summarize what is done, what remains, and which acceptance criteria are unmet, then stop and wait for the user.",
        },
      ],
      continue: false,
    };
  }
  const next = state.continuations + 1;
  const checkpoint = state.checkpointEvery > 0 && next % state.checkpointEvery === 0;
  return {
    entries: [
      ...previousEntries,
      { type: "custom", customType: GOAL_CUSTOM_TYPE, data: { kind: "continue" } satisfies GoalEntry },
      {
        type: "custom_message",
        customType: GOAL_CONTINUATION_TYPE,
        display: false,
        content: checkpoint
          ? "Checkpoint: summarize progress against the acceptance criteria, update the todo_write plan for the remaining work, then continue."
          : "Continue working toward the goal. Keep todo_write current. If every acceptance criterion is met with verifiable evidence, call goal_report and stop; otherwise keep going.",
      },
    ],
    continue: true,
  };
}

function goalTurnEnd(
  prompt: SessionPromptPolicy,
  event: TurnEndEvent,
  sessionManager: Parameters<typeof readSessionGoalState>[0],
): GoalTurnDecision | undefined {
  syncGoalPromptSection(prompt, sessionManager);
  if (event.outcome !== "completed") return;
  const state = readSessionGoalState(sessionManager);
  if (!state) return;
  return decideGoalTurnEnd(state, event.entries) ?? undefined;
}

function createGoalReportTool() {
  return defineTool({
    name: GOAL_REPORT_TOOL_NAME,
    label: "Goal report",
    description:
      "Report the status of the active goal's acceptance criteria with evidence. Call it only when every criterion is met with verifiable evidence, or when you are blocked and need a user decision. The user reviews the report in the goal panel and accepts the goal or sends it back with feedback.",
    promptSnippet: "Report goal acceptance criteria with evidence when the goal is verified",
    promptGuidelines: [
      "Call goal_report only in goal mode, when every criterion is met with verifiable evidence or you are blocked and need a user decision.",
      "Cite concrete evidence per criterion: test output, file paths, command results, screenshots. Never mark a criterion met without evidence.",
      "After goal_report, stop and wait for the user to accept the goal or send it back.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      summary: Type.String({
        maxLength: MAX_GOAL_LENGTH,
        description: "One-paragraph summary of the outcome",
      }),
      criteria: Type.Array(
        Type.Object({
          criterion: Type.String({ maxLength: MAX_GOAL_CRITERION_LENGTH }),
          met: Type.Boolean({ description: "Whether this criterion is met, backed by the evidence below" }),
          evidence: Type.String({
            maxLength: MAX_GOAL_EVIDENCE_LENGTH,
            description: "Concrete evidence: test output, file paths, command results, screenshots",
          }),
        }),
        { minItems: 1, maxItems: MAX_GOAL_CRITERIA },
      ),
    }),
    async execute(_toolCallId, params) {
      const met = params.criteria.filter((criterion) => criterion.met).length;
      return {
        content: [
          {
            type: "text" as const,
            text: `Goal report recorded (${met}/${params.criteria.length} criteria met). Stop working and wait for the user's review.`,
          },
        ],
        details: {
          summary: params.summary,
          criteria: params.criteria,
        } satisfies GoalReportState,
      };
    },
  });
}

export function createGoalModeExtension(prompt: SessionPromptPolicy): InlineExtension {
  return {
    name: "pi-desktop-goal",
    builtin: true,
    factory(pi) {
      pi.registerCommand(GOAL_COMMAND_NAME, {
        description: "Work toward a goal with acceptance criteria until verified",
        handler: async (args, ctx) => startGoal(pi, prompt, args, ctx),
      });

      pi.registerTool(createGoalReportTool());

      pi.on("session_start", (_event, ctx) => {
        syncGoalPromptSection(prompt, ctx.sessionManager);
      });

      // Runs before the desktop prompt extension resolves the system prompt, so
      // each request sees the committed continuation count and goal status.
      pi.on("before_agent_start", (_event, ctx) => {
        syncGoalPromptSection(prompt, ctx.sessionManager);
      });

      pi.on("turn_end", (event, ctx) => goalTurnEnd(prompt, event, ctx.sessionManager));
    },
  };
}
