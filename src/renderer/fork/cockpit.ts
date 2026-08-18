export type CockpitRole = "cockpit" | "left" | "right" | "full";

export function readCockpitRole(hash: string): CockpitRole {
  if (hash === "" || hash === "#cockpit") return "cockpit";
  if (hash === "#cockpit-left") return "left";
  if (hash === "#cockpit-right") return "right";
  return "full";
}

export function shouldCollapseSidebarAfterSessionPick(
  role: CockpitRole,
  isMobile: boolean,
  isRestore: boolean,
): boolean {
  return role !== "left" && role !== "cockpit" && isMobile && !isRestore;
}
