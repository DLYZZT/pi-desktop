export type WindowShowEvents = {
  once(event: "ready-to-show", listener: () => void): unknown;
  on(event: "hide" | "close" | "closed", listener: () => void): unknown;
  removeListener(event: "ready-to-show" | "hide" | "close" | "closed", listener: () => void): unknown;
};

type WindowShowTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

export function installWindowShowFallback(
  window: WindowShowEvents,
  show: () => void,
  delayMs = 3_000,
  timers: WindowShowTimers = globalThis,
): () => void {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (timer) timers.clearTimeout(timer);
    timer = undefined;
    window.removeListener("ready-to-show", onReady);
    window.removeListener("hide", cancel);
    window.removeListener("close", cancel);
    window.removeListener("closed", cancel);
  };
  const finish = (shouldShow: boolean) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (shouldShow) show();
  };
  const onReady = () => finish(true);
  const cancel = () => finish(false);

  window.once("ready-to-show", onReady);
  window.on("hide", cancel);
  window.on("close", cancel);
  window.on("closed", cancel);
  timer = timers.setTimeout(() => finish(true), delayMs);
  timer.unref?.();
  return cancel;
}
