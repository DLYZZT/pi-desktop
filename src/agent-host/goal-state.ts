/**
 * Goal-mode state derived from the current branch, plus the system-prompt block
 * that keeps the goal visible to the model across compaction.
 *
 * The branch is the only source of truth, matching the todo plan: lifecycle
 * custom entries and the newest successful `goal_report` tool result rebuild the
 * state after reload, branch switches and compaction. Nothing here keeps an
 * in-memory authority the renderer could drift from.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  GoalCriterionReport,
  GoalReportState,
  GoalResolveAction,
  GoalState,
  SessionEntry,
} from "../shared/types.ts";

export const GOAL_CUSTOM_TYPE = "pi-desktop-goal";
export const GOAL_REPORT_TOOL_NAME = "goal_report";
export const GOAL_CONTINUATION_TYPE = "pi-desktop-goal-continue";

export const MAX_GOAL_LENGTH = 4000;
export const MAX_GOAL_CRITERIA = 20;
export const MAX_GOAL_CRITERION_LENGTH = 500;
export const MAX_GOAL_EVIDENCE_LENGTH = 2000;
export const MAX_GOAL_FEEDBACK_LENGTH = 2000;
export const DEFAULT_MAX_CONTINUATIONS = 8;
export const CHECKPOINT_EVERY = 4;
export const EXTEND_STEP = 4;

export type GoalEntry =
  | {
      kind: "start";
      goal: string;
      criteria: string[];
      maxContinuations: number;
      checkpointEvery: number;
    }
  | { kind: "continue" }
  | { kind: "budget_exhausted" }
  | { kind: "resolve"; action: GoalResolveAction; feedback?: string; extra?: number };

type StartEntry = Extract<GoalEntry, { kind: "start" }>;
type ResolveEntry = Extract<GoalEntry, { kind: "resolve" }>;

type BranchEvent =
  | { kind: "start"; entry: StartEntry }
  | { kind: "continue" }
  | { kind: "budget_exhausted" }
  | ResolveEntry
  | { kind: "report"; report: GoalReportState };

const RESOLVE_ACTIONS: readonly GoalResolveAction[] = ["accept", "reject", "stop", "extend"];

export function isGoalResolveAction(value: unknown): value is GoalResolveAction {
  return typeof value === "string" && (RESOLVE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readStartEntry(data: unknown): StartEntry | null {
  if (!isRecord(data) || data.kind !== "start") return null;
  const goal = typeof data.goal === "string" ? data.goal.trim().slice(0, MAX_GOAL_LENGTH) : "";
  if (!goal) return null;
  const criteria = Array.isArray(data.criteria)
    ? data.criteria
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, MAX_GOAL_CRITERIA)
        .map((item) => item.trim().slice(0, MAX_GOAL_CRITERION_LENGTH))
    : [];
  return {
    kind: "start",
    goal,
    criteria,
    maxContinuations: readPositiveInt(data.maxContinuations, DEFAULT_MAX_CONTINUATIONS),
    checkpointEvery: readPositiveInt(data.checkpointEvery, CHECKPOINT_EVERY),
  };
}

function readResolveEntry(data: unknown): ResolveEntry | null {
  if (!isRecord(data) || data.kind !== "resolve" || !isGoalResolveAction(data.action)) return null;
  const feedback =
    typeof data.feedback === "string" ? data.feedback.trim().slice(0, MAX_GOAL_FEEDBACK_LENGTH) : undefined;
  const extra =
    typeof data.extra === "number" && Number.isSafeInteger(data.extra) && data.extra > 0 ? data.extra : undefined;
  return {
    kind: "resolve",
    action: data.action,
    ...(feedback ? { feedback } : {}),
    ...(extra ? { extra } : {}),
  };
}

function readReport(details: unknown): GoalReportState | null {
  if (!isRecord(details) || !Array.isArray(details.criteria) || details.criteria.length === 0) return null;
  const criteria: GoalCriterionReport[] = [];
  for (const item of details.criteria.slice(0, MAX_GOAL_CRITERIA)) {
    if (!isRecord(item)) return null;
    const criterion = typeof item.criterion === "string" ? item.criterion.trim() : "";
    if (!criterion || typeof item.met !== "boolean") return null;
    const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
    criteria.push({
      criterion: criterion.slice(0, MAX_GOAL_CRITERION_LENGTH),
      met: item.met,
      evidence: evidence.slice(0, MAX_GOAL_EVIDENCE_LENGTH),
    });
  }
  const summary = typeof details.summary === "string" ? details.summary.trim().slice(0, MAX_GOAL_LENGTH) : "";
  return { criteria, ...(summary ? { summary } : {}) };
}

function classifyEntry(entry: SessionEntry): BranchEvent | null {
  if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE) {
    const data = entry.data;
    if (!isRecord(data)) return null;
    if (data.kind === "start") {
      const start = readStartEntry(data);
      return start ? { kind: "start", entry: start } : null;
    }
    if (data.kind === "continue") return { kind: "continue" };
    if (data.kind === "budget_exhausted") return { kind: "budget_exhausted" };
    if (data.kind === "resolve") return readResolveEntry(data);
    return null;
  }
  if (entry.type === "message" && entry.message.role === "toolResult") {
    const message = entry.message;
    if (message.toolName !== GOAL_REPORT_TOOL_NAME || message.isError) return null;
    const report = readReport(message.details);
    return report ? { kind: "report", report } : null;
  }
  return null;
}

/**
 * The goal this branch currently shows. The newest goal event wins: a report
 * waits for acceptance, a resolve decides, and anything else keeps working.
 * A goal only exists once a `start` entry precedes the newest event.
 */
export function readSessionGoalState(manager: Pick<SessionManager, "getBranch">): GoalState | null {
  const branch = manager.getBranch() as SessionEntry[];
  let startIndex = -1;
  let start: StartEntry | null = null;
  let latest: BranchEvent | null = null;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const event = classifyEntry(branch[index]);
    if (!event) continue;
    if (event.kind === "start") {
      startIndex = index;
      start = event.entry;
      break;
    }
    if (!latest) latest = event;
  }
  if (startIndex < 0 || !start) return null;

  let continuations = 0;
  let extra = 0;
  for (let index = startIndex + 1; index < branch.length; index += 1) {
    const event = classifyEntry(branch[index]);
    if (!event) continue;
    if (event.kind === "continue") continuations += 1;
    else if (event.kind === "resolve" && event.action === "extend") extra += event.extra ?? EXTEND_STEP;
  }

  let status: GoalState["status"] = "working";
  let report: GoalReportState | null = null;
  let feedback: string | null = null;
  if (latest) {
    switch (latest.kind) {
      case "budget_exhausted":
        status = "budget_exhausted";
        break;
      case "resolve":
        if (latest.action === "accept") status = "accepted";
        else if (latest.action === "stop") status = "stopped";
        else if (latest.action === "reject") feedback = latest.feedback ?? null;
        break;
      case "report":
        status = "awaiting_acceptance";
        report = latest.report;
        break;
      default:
        break;
    }
  }

  return {
    goal: start.goal,
    criteria: start.criteria,
    status,
    continuations,
    maxContinuations: start.maxContinuations + extra,
    checkpointEvery: start.checkpointEvery,
    report,
    feedback,
  };
}

export interface GoalPromptPolicyLike {
  setGoalSection(section: string | null): void;
}

/** Prompt block that survives compaction; `null` once the goal is decided. */
export function goalPromptSection(state: GoalState): string | null {
  if (state.status === "accepted" || state.status === "stopped") return null;
  const lines = [
    "Goal mode is active for this session.",
    `Goal: ${state.goal}`,
    state.criteria.length
      ? ["User acceptance criteria:", ...state.criteria.map((criterion) => `- ${criterion}`)].join("\n")
      : "User acceptance criteria: none supplied — define concrete, user-verifiable criteria in your first reply and evaluate exactly those in goal_report.",
    `Status: ${state.status}. Auto-continuations used: ${state.continuations}/${state.maxContinuations}.`,
    "Rules:",
    "- Track the work with todo_write and keep the list current.",
    "- Keep working while the status is working; do not stop between steps to ask for permission.",
    `- Call ${GOAL_REPORT_TOOL_NAME} only when every criterion is met with verifiable evidence, or when you are blocked and need a user decision. Never mark a criterion met without evidence.`,
    "- After goal_report, stop and wait for the user to accept the goal or send it back.",
  ];
  return lines.join("\n");
}

/** Re-derive the goal and refresh the prompt block; returns the derived state. */
export function syncGoalPromptSection(
  policy: GoalPromptPolicyLike,
  manager: Pick<SessionManager, "getBranch">,
): GoalState | null {
  const state = readSessionGoalState(manager);
  policy.setGoalSection(state ? goalPromptSection(state) : null);
  return state;
}
