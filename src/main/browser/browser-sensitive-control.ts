import type { BrowserControlState } from "../../contract/browser.ts";

export function canResumeSensitiveAgentControl(
  expectedGeneration: number,
  currentGeneration: number,
  control: BrowserControlState,
): boolean {
  return expectedGeneration === currentGeneration && control === "waiting-for-approval";
}
