import { useLayoutEffect, useMemo } from "react";
import type { SessionPresentation, SessionPresentationStore } from "@/lib/session-presentation-store";

/** A stale chat may neither publish into nor clear its replacement's metadata. */
export function useSessionPresentation(store: SessionPresentationStore | undefined, snapshot: SessionPresentation) {
  const publisher = useMemo(() => store?.createPublisher(), [store]);
  useLayoutEffect(() => {
    publisher?.activate();
    return () => publisher?.release();
  }, [publisher]);
  useLayoutEffect(() => {
    publisher?.update(snapshot);
  }, [publisher, snapshot]);
}
