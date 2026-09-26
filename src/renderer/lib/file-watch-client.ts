import type { Streams } from "@contract/api";
import { call, subscribe } from "./api-client";

type FileChange = Streams["files.changed"];

/** One caller owns one subscription and one Host lease, even for a shared path. */
export function watchFile(
  path: string,
  {
    sourceSessionId,
    onChange,
    onStatus,
  }: {
    sourceSessionId?: string | null;
    onChange: (event: FileChange) => void;
    onStatus: (watching: boolean) => void;
  },
): () => void {
  const watchId = crypto.randomUUID();
  let closed = false;
  let started = false;
  let ready = false;
  let unsubscribe: (() => void) | undefined;
  let pendingChange: FileChange | undefined;
  let pendingError = false;

  const close = () => {
    if (closed) return;
    closed = true;
    pendingChange = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    // This retires a pending Host acquisition too. Stopping is independent of
    // waiting for the start acknowledgement, which can arrive after unmount.
    if (started) void call("files.watchStop", { path, watchId }).catch(() => {});
  };
  const unavailable = () => {
    if (closed) return;
    close();
    onStatus(false);
  };

  void (async () => {
    const off = await subscribe("files.changed", path, (event) => {
      if (closed || event.path !== path) return;
      if (!ready) {
        // Streams are keyed by path. Another consumer can already be watching
        // it, so publish nothing before this caller's authorization succeeds.
        if (event.event === "change") pendingChange = event;
        if (event.event === "error") pendingError = true;
        return;
      }
      if (event.event === "change") onChange(event);
      if (event.event === "error") unavailable();
    });
    if (closed) {
      off();
      return;
    }
    unsubscribe = off;
    started = true;
    await call("files.watchStart", { path, sourceSessionId: sourceSessionId ?? undefined, watchId });
    if (closed) return;
    ready = true;
    if (pendingError) {
      unavailable();
      return;
    }
    onStatus(true);
    if (!closed && pendingChange) onChange(pendingChange);
    pendingChange = undefined;
  })().catch(unavailable);

  return close;
}
