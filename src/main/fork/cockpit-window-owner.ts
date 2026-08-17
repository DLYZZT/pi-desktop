import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { BrowserWindow } from "electron";

import { sessionTuiWindowTitle } from "./session-tui-spawn";

const LINK_TIMEOUT_MS = 6_000;

function nativeHandleAsDecimal(window: BrowserWindow): string {
  const handle = window.getNativeWindowHandle();
  if (handle.length >= 8) return handle.readBigUInt64LE().toString();
  return String(handle.readUInt32LE());
}

export function buildCockpitOwnershipScript(titles: string[], childHandles: string[]): string {
  const safeTitles = titles.map((title) => `'${title.replaceAll("'", "''")}'`).join(",");
  const safeHandles = childHandles.map((handle) => `'${handle.replaceAll("'", "''")}'`).join(",");
  return `
$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PiCockpitWindowOwner {
  private const int GWLP_HWNDPARENT = -8;
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
  private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
  private static extern int SetWindowLong32(IntPtr window, int index, int value);

  public static long FindExactTitle(string expectedTitle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, state) => {
      var title = new StringBuilder(512);
      GetWindowText(window, title, title.Capacity);
      if (String.Equals(title.ToString(), expectedTitle, StringComparison.Ordinal)) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found.ToInt64();
  }

  public static void SetOwner(long child, long owner) {
    if (IntPtr.Size == 8) {
      SetWindowLongPtr64(new IntPtr(child), GWLP_HWNDPARENT, new IntPtr(owner));
      return;
    }
    SetWindowLong32(new IntPtr(child), GWLP_HWNDPARENT, unchecked((int)owner));
  }
}
'@
Add-Type -TypeDefinition $source
$titles = @(${safeTitles})
$children = @(${safeHandles})
$deadline = [DateTime]::UtcNow.AddMilliseconds(${LINK_TIMEOUT_MS})
do {
  foreach ($title in $titles) {
    $owner = [PiCockpitWindowOwner]::FindExactTitle($title)
    if ($owner -ne 0) {
      foreach ($child in $children) {
        [PiCockpitWindowOwner]::SetOwner([Int64]::Parse($child), $owner)
      }
      exit 0
    }
  }
  Start-Sleep -Milliseconds 75
} while ([DateTime]::UtcNow -lt $deadline)
exit 2
`.trim();
}

export function linkCockpitWindowsToSession(
  sessionId: string,
  cwd: string,
  windows: Array<BrowserWindow | null>,
): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const liveWindows = windows.filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()));
  if (liveWindows.length === 0) return Promise.resolve(false);
  const script = buildCockpitOwnershipScript(
    [sessionTuiWindowTitle(sessionId), `π - ${basename(cwd)}`],
    liveWindows.map(nativeHandleAsDecimal),
  );
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedCommand],
      { windowsHide: true, timeout: LINK_TIMEOUT_MS + 1_000 },
      (error) => resolve(!error),
    );
  });
}
