export type DirectoryRefreshAction = "reload" | "mark-stale" | "none";

export function directoryRefreshAction(open: boolean, loaded: boolean): DirectoryRefreshAction {
  if (!loaded) return "none";
  return open ? "reload" : "mark-stale";
}

export function shouldLoadDirectoryOnExpand(loaded: boolean, stale: boolean): boolean {
  return !loaded || stale;
}
