import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOLCHAIN_SECTION = /\n*<pi-desktop-toolchain revision="\d+">[\s\S]*?<\/pi-desktop-toolchain>\n*/g;

/** Session-local prompt policy. The SDK owns the transcript and provider prompt. */
export class SessionPromptPolicy {
  private forceEmpty: boolean;
  private toolchainPrompt = "";

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

  resolve(systemPrompt: string): string {
    if (this.forceEmpty) return "";
    if (!this.toolchainPrompt) return systemPrompt;
    const base = systemPrompt.replace(TOOLCHAIN_SECTION, "").trimEnd();
    return `${base}\n\n${this.toolchainPrompt}`.trim();
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
