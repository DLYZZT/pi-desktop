import type { HerdrFleetSnapshot } from "@contract/herdr";

export function getFleetPresentation(ready: boolean, fleet: HerdrFleetSnapshot | null) {
  const hasFleet = (fleet?.workspaces.length ?? 0) > 0 || (fleet?.panes.length ?? 0) > 0;
  return {
    hasFleet,
    interactive: ready && fleet?.stale !== true,
    showEmpty: ready && !hasFleet,
  };
}

export function getFleetTriggerSpacing(alignRight: boolean, rightInset: number) {
  return {
    marginLeft: alignRight ? "auto" : 10,
    marginRight: alignRight ? Math.max(0, rightInset) : 0,
  } as const;
}
