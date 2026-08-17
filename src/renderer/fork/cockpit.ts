export type CockpitRole = "left" | "right" | "full";

export function readCockpitRole(hash: string): CockpitRole {
  if (hash === "#cockpit-left") return "left";
  if (hash === "#cockpit-right") return "right";
  return "full";
}
