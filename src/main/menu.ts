import { app, Menu, shell, type BrowserWindow } from "electron";

export function installAppMenu(getWindow: () => BrowserWindow | null, onCheckForUpdates?: () => void): void {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "Check for Updates…",
                click: () => {
                  if (onCheckForUpdates) {
                    onCheckForUpdates();
                    return;
                  }
                  const win = getWindow();
                  win?.show();
                  win?.focus();
                  win?.webContents.send("menu:check-for-updates");
                },
              },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  getWindow()?.webContents.send("menu:settings");
                },
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            getWindow()?.webContents.send("menu:new-session");
          },
        },
        {
          label: "Switch Session…",
          accelerator: "CmdOrCtrl+K",
          click: () => {
            getWindow()?.webContents.send("menu:switch-session");
          },
        },
        { type: "separator" },
        ...(isMac
          ? []
          : [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  getWindow()?.webContents.send("menu:settings");
                },
              },
              { type: "separator" as const },
            ]),
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        ...(isWindows
          ? [
              {
                label: "Check for Updates…",
                click: () => {
                  if (onCheckForUpdates) {
                    onCheckForUpdates();
                    return;
                  }
                  const win = getWindow();
                  win?.show();
                  win?.focus();
                  win?.webContents.send("menu:check-for-updates");
                },
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: "Open Logs Folder",
          click: () => {
            void shell.openPath(app.getPath("logs"));
          },
        },
        {
          label: "Export Diagnostics…",
          click: () => {
            getWindow()?.webContents.send("menu:export-diagnostics");
          },
        },
        { type: "separator" },
        {
          label: "Learn More",
          click: () => {
            void shell.openExternal("https://github.com/DLYZZT/pi-desktop");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
