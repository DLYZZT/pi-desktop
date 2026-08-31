import type { HerdrTerminalState, HerdrTerminalStatus } from "@contract/herdr";

export function getTerminalViewState(options: {
  opening: boolean;
  ownershipState: "controlled-elsewhere" | "controller-lost" | null;
  status: HerdrTerminalStatus | null;
}): HerdrTerminalState {
  if (options.opening) return "opening";
  if (options.ownershipState) return options.ownershipState;
  if (options.status?.state === "controlling" && !options.status.controller) return "controlled-elsewhere";
  return options.status?.state ?? "closed";
}

export function terminalCloseOwnershipState(
  previousMode: "observe" | "control",
  nextState: HerdrTerminalState,
): "controller-lost" | null {
  return previousMode === "control" && (nextState === "closed" || nextState === "error") ? "controller-lost" : null;
}

export function terminalFrameDisposition(
  previousSeq: number | null,
  seq: number,
  full: boolean,
): "accept" | "duplicate" | "gap" {
  if (previousSeq !== null && seq <= previousSeq) return "duplicate";
  if (full) return "accept";
  return previousSeq !== null && seq === previousSeq + 1 ? "accept" : "gap";
}
