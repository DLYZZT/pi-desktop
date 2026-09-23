import type { HerdrFleetSnapshot } from "@contract/herdr";

export type HerdrSnapshotOrder = { sourceGeneration: number; revision: number };

export function isNewerHerdrSnapshot(candidate: HerdrSnapshotOrder, current: HerdrSnapshotOrder | null): boolean {
  if (!current) return true;
  if (candidate.sourceGeneration !== current.sourceGeneration) {
    return candidate.sourceGeneration > current.sourceGeneration;
  }
  return candidate.revision > current.revision;
}

export function invalidateHerdrFleetSnapshot(current: HerdrFleetSnapshot | null): HerdrFleetSnapshot | null {
  if (!current) return null;
  return {
    ...current,
    stale: true,
  };
}
