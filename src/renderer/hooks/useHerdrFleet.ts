import { useCallback, useEffect, useRef, useState } from "react";
import { call, subscribe } from "@/lib/api-client";
import { invalidateHerdrFleetSnapshot, isNewerHerdrSnapshot, type HerdrSnapshotOrder } from "./herdr-snapshot-order";
import type { HerdrFleetSnapshot } from "@contract/herdr";

export function useHerdrFleet(enabled: boolean) {
  const [fleet, setFleet] = useState<HerdrFleetSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderRef = useRef<HerdrSnapshotOrder | null>(null);
  const requestGenerationRef = useRef(0);

  const acceptSnapshot = useCallback((snapshot: HerdrFleetSnapshot) => {
    if (!isNewerHerdrSnapshot(snapshot, orderRef.current)) return false;
    orderRef.current = snapshot;
    setFleet(snapshot);
    setLoading(false);
    setError(null);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    const requestGeneration = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const snapshot = await call("herdr.snapshot");
      if (requestGeneration === requestGenerationRef.current) acceptSnapshot(snapshot);
      return snapshot;
    } catch (nextError) {
      if (requestGeneration === requestGenerationRef.current) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
      return null;
    } finally {
      if (requestGeneration === requestGenerationRef.current) setLoading(false);
    }
  }, [acceptSnapshot, enabled]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    if (!enabled) {
      requestGenerationRef.current += 1;
      setFleet((current) => invalidateHerdrFleetSnapshot(current));
      setLoading(false);
      return;
    }
    void subscribe("herdr.fleet", "*", (snapshot) => {
      if (!disposed) acceptSnapshot(snapshot);
    })
      .then((release) => {
        if (disposed) {
          release();
          return;
        }
        unsubscribe = release;
        void refresh();
      })
      .catch((nextError: unknown) => {
        if (!disposed) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          void refresh();
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [acceptSnapshot, enabled, refresh]);

  return { fleet, loading, error, refresh };
}
