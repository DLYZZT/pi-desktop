import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOLCHAIN_SECTION = /\n*<pi-desktop-toolchain revision="\d+">[\s\S]*?<\/pi-desktop-toolchain>\n*/g;
const GOAL_SECTION = /\n*<pi-desktop-goal>[\s\S]*?<\/pi-desktop-goal>\n*/g;

/** Session-local prompt policy. The SDK owns the transcript and provider prompt. */
export class SessionPromptPolicy {
  private forceEmpty: boolean;
  private toolchainPrompt = "";
  private goalPrompt = "";

  constructor(forceEmpty: boolean) {
    this.forceEmpty = forceEmpty;
  }

  setForceEmpty(forceEmpty: boolean): void {
    this.forceEmpty = forceEmpty;
  }

  setToolchainSummary(revision: number, summary: readonly string[]): void {
    this.toolchainPrompt = [
      `<pi-desktop-toolchain revision="${revision}">`,
      ...summary,
      "</pi-desktop-toolchain>",
    ].join("\n");
  }

  /** Goal-mode block; `null` clears it once the goal is accepted or stopped. */
  setGoalSection(section: string | null): void {
    this.goalPrompt = section ? ["<pi-desktop-goal>", section, "</pi-desktop-goal>"].join("\n") : "";
  }

  resolve(systemPrompt: string): string {
    if (this.forceEmpty) return "";
    if (!this.toolchainPrompt && !this.goalPrompt) return systemPrompt;
    let resolved = systemPrompt.replace(TOOLCHAIN_SECTION, "").replace(GOAL_SECTION, "").trimEnd();
    if (this.toolchainPrompt) resolved = `${resolved}\n\n${this.toolchainPrompt}`.trim();
    if (this.goalPrompt) resolved = `${resolved}\n\n${this.goalPrompt}`.trim();
    return resolved;
  }
}

/** Inline extensions load after filesystem extensions, so the Desktop policy is the final prompt decision. */
export function createDesktopPromptExtension(policy: SessionPromptPolicy) {
  return {
    name: "pi-desktop-prompt",
    hidden: true,
    factory(pi: ExtensionAPI) {
      pi.on("before_agent_start", (event) => ({ systemPrompt: policy.resolve(event.systemPrompt) }));
    },
  };
}
