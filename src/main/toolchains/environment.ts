import path from "node:path";

export function windowsNativePathToMsys(value: string): string | undefined {
  if (!value || value.includes("\0") || value.includes("\r") || value.includes("\n")) return undefined;
  const normalized = path.win32.normalize(value);
  const drive = normalized.match(/^([A-Za-z]):(?:\\(.*))?$/);
  if (drive) {
    const tail = (drive[2] ?? "").replace(/\\/g, "/");
    return `/${drive[1]!.toLowerCase()}${tail ? `/${tail}` : ""}`;
  }
  if (normalized.startsWith("\\\\")) return `//${normalized.slice(2).replace(/\\/g, "/")}`;
  return undefined;
}

export function portableGitNativePathEntries(componentRoot: string): string[] {
  return [path.win32.join(componentRoot, "cmd")];
}

export function portableGitShellPathEntries(componentRoot: string): string[] {
  return [
    path.win32.join(componentRoot, "cmd"),
    path.win32.join(componentRoot, "bin"),
    path.win32.join(componentRoot, "usr", "bin"),
    path.win32.join(componentRoot, "mingw64", "bin"),
  ];
}

export function portableGitShellEnvPatch(): Record<string, string> {
  return {
    MSYSTEM: "MINGW64",
    CHERE_INVOKING: "1",
    MSYS2_PATH_TYPE: "inherit",
  };
}
