import path from "node:path";

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
