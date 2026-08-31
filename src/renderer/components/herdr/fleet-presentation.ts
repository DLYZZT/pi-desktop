import type { HerdrFleetSnapshot } from "@contract/herdr";

export function getFleetPresentation(ready: boolean, fleet: HerdrFleetSnapshot | null) {
  const hasFleet = (fleet?.workspaces.length ?? 0) > 0 || (fleet?.panes.length ?? 0) > 0;
  return {
    hasFleet,
    interactive: ready && fleet?.stale !== true,
    showEmpty: ready && !hasFleet,
  };
}
