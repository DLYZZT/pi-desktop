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

export function isTrustedDesktopIpcSender(window: TrustedWindow | null, event: IpcSender): boolean {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame,
  );
}
