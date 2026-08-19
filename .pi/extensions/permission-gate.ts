/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 *
 * Grants are whole-class: Session allow covers every matching command
 * until this process tears the gate down (new / resume / fork / reload).
 *
 * State lives on globalThis so a user-global copy and this project copy
 * share one decision per toolCallId.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DANGEROUS_PATTERNS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

const ONCE = "Once";
const SESSION = "Session";
const DENY = "Deny";

type GateDecision = undefined | { block: true; reason: string };

type GateState = {
  sessionAllowed: boolean;
  decisions: Map<string, GateDecision>;
};

const GATE_KEY = "__piDangerousBashGate";

function gateState(): GateState {
  const g = globalThis as Record<string, unknown>;
  const existing = g[GATE_KEY];
  if (existing) return existing as GateState;
  const created: GateState = { sessionAllowed: false, decisions: new Map() };
  g[GATE_KEY] = created;
  return created;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    if (!DANGEROUS_PATTERNS.some((p) => p.test(command))) return undefined;

    const state = gateState();
    if (state.sessionAllowed) return undefined;
    if (state.decisions.has(event.toolCallId)) return state.decisions.get(event.toolCallId);

    if (!ctx.hasUI) {
      const blocked = { block: true as const, reason: "Dangerous command blocked (no UI for confirmation)" };
      state.decisions.set(event.toolCallId, blocked);
      return blocked;
    }

    const choice = await ctx.ui.select(
      `⚠️ Dangerous command:\n\n  ${command}\n\nAllow this class (rm -rf / sudo / chmod|chown 777)?`,
      [ONCE, SESSION, DENY],
    );

    if (choice === SESSION) {
      state.sessionAllowed = true;
      state.decisions.set(event.toolCallId, undefined);
      return undefined;
    }
    if (choice === ONCE) {
      state.decisions.set(event.toolCallId, undefined);
      return undefined;
    }

    const blocked = { block: true as const, reason: "Blocked by user" };
    state.decisions.set(event.toolCallId, blocked);
    return blocked;
  });
}
