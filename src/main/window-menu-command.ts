export type MenuCommandWindow = {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  webContents: {
    isLoadingMainFrame(): boolean;
    once(event: "did-finish-load", listener: () => void): unknown;
    send(channel: string): void;
  };
};

export function sendWindowMenuCommand(getWindow: () => MenuCommandWindow | null, channel: string): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send(channel);
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
  else send();
}
