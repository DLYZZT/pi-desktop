type TrustedWindow = {
  isDestroyed(): boolean;
  webContents: {
    mainFrame: unknown;
  };
};

type IpcSender = {
  sender: unknown;
  senderFrame: unknown;
};

export function isTrustedDesktopIpcSender(
  window: TrustedWindow | readonly (TrustedWindow | null)[] | null,
  event: IpcSender,
): boolean {
  const windows = Array.isArray(window) ? window : [window];
  return windows.some((candidate) =>
    Boolean(
      candidate &&
      !candidate.isDestroyed() &&
      event.sender === candidate.webContents &&
      event.senderFrame === candidate.webContents.mainFrame,
    ),
  );
}
