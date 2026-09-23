export type TerminalControlOpen = (takeover: boolean) => Promise<string | undefined>;

export async function runTerminalControlFlow(options: {
  confirmInitial: () => boolean;
  confirmTakeover: () => boolean;
  openControl: TerminalControlOpen;
  restoreObserve: () => Promise<unknown>;
  onBusy?: () => void;
}): Promise<"cancelled" | "opened" | "failed"> {
  if (!options.confirmInitial()) return "cancelled";
  const result = await options.openControl(false);
  if (result !== "HERDR_TERMINAL_BUSY") return result ? "failed" : "opened";
  options.onBusy?.();
  if (!options.confirmTakeover()) {
    await options.restoreObserve();
    return "cancelled";
  }
  return (await options.openControl(true)) ? "failed" : "opened";
}
