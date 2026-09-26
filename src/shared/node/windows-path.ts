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
