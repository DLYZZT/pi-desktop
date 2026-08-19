param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Class,
  [string]$TargetPid,
  [string]$Child,
  [string]$Parent,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SpikeNative {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")]
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

function Parse-Hwnd([string]$hex) {
  $text = $hex.Trim()
  if ($text.StartsWith("0x") -or $text.StartsWith("0X")) {
    return [IntPtr][int64]::Parse($text.Substring(2), [System.Globalization.NumberStyles]::AllowHexSpecifier)
  }
  return [IntPtr][int64]$text
}

function Format-Hwnd([IntPtr]$hwnd) {
  return ("0x{0:x}" -f $hwnd.ToInt64())
}

switch ($Action) {
  "find" {
    if ($Class) {
      $hwnd = [SpikeNative]::FindWindow($Class, $null)
      if ($hwnd -ne [IntPtr]::Zero) {
        Write-Output (Format-Hwnd $hwnd)
        exit 0
      }
    }
    if ($TargetPid) {
      $target = [uint32]$TargetPid
      $script:found = [IntPtr]::Zero
      $cb = [SpikeNative+EnumWindowsProc] {
        param([IntPtr]$h, [IntPtr]$l)
        $procId = [uint32]0
        [void][SpikeNative]::GetWindowThreadProcessId($h, [ref]$procId)
        if ($procId -eq $target -and [SpikeNative]::IsWindowVisible($h)) {
          $script:found = $h
          return $false
        }
        return $true
      }
      [void][SpikeNative]::EnumWindows($cb, [IntPtr]::Zero)
      if ($script:found -ne [IntPtr]::Zero) {
        Write-Output (Format-Hwnd $script:found)
        exit 0
      }
    }
    exit 1
  }
  "parent" {
    $childH = Parse-Hwnd $Child
    $parentH = Parse-Hwnd $Parent
    $style = [uint32][SpikeNative]::GetWindowLong($childH, -16)
    $style = ($style -band (-bnot [uint32]0x80CF0000)) -bor [uint32]0x50000000
    [void][SpikeNative]::SetWindowLong($childH, -16, [int]$style)
    $prev = [SpikeNative]::SetParent($childH, $parentH)
    [void][SpikeNative]::SetWindowPos($childH, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0060)
    [void][SpikeNative]::MoveWindow($childH, $X, $Y, $W, $H, $true)
    Write-Output (Format-Hwnd $prev)
    exit 0
  }
  "move" {
    $childH = Parse-Hwnd $Child
    [void][SpikeNative]::MoveWindow($childH, $X, $Y, $W, $H, $true)
    exit 0
  }
  "alive" {
    $childH = Parse-Hwnd $Child
    if ([SpikeNative]::IsWindow($childH)) {
      Write-Output "1"
      exit 0
    }
    exit 1
  }
  default {
    Write-Error "unknown action $Action"
    exit 2
  }
}
