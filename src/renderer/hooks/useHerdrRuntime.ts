import { useCallback, useEffect, useRef, useState } from "react";
import { call, subscribe } from "@/lib/api-client";
import { isNewerHerdrSnapshot, type HerdrSnapshotOrder } from "./herdr-snapshot-order";
import type { HerdrRuntimeSnapshot } from "@contract/herdr";

export function useHerdrRuntime() {
  const [runtime, setRuntime] = useState<HerdrRuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const orderRef = useRef<HerdrSnapshotOrder | null>(null);
  const requestGenerationRef = useRef(0);

  const acceptSnapshot = useCallback((snapshot: HerdrRuntimeSnapshot) => {
    if (!isNewerHerdrSnapshot(snapshot, orderRef.current)) return false;
    orderRef.current = snapshot;
    setRuntime(snapshot);
    setLoading(false);
    setError(null);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const snapshot = await call("herdr.runtime.get");
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
  }, [acceptSnapshot]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribe("herdr.runtime", "*", (snapshot) => {
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
  }, [acceptSnapshot, refresh]);

  return { runtime, loading, error, refresh };
}
