export type DeveloperViewRole = "reload" | "forceReload" | "toggleDevTools";

export function developerViewRoles(isDev: boolean): DeveloperViewRole[] {
  return isDev ? ["reload", "forceReload", "toggleDevTools"] : [];
}
