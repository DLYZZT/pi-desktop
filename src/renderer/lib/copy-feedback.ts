type TimerHandle = ReturnType<typeof setTimeout>;

export class CopyFeedbackTimer {
  private timer: TimerHandle | null = null;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (timer: TimerHandle) => void;

  constructor(
    schedule: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
    cancel: (timer: TimerHandle) => void = clearTimeout,
  ) {
    this.schedule = schedule;
    this.cancel = cancel;
  }

  restart(callback: () => void, delayMs: number): void {
    this.dispose();
    this.timer = this.schedule(() => {
      this.timer = null;
      callback();
    }, delayMs);
  }

  dispose(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }
}

export async function performCopyWithFeedback(
  text: string,
  write: (value: string) => Promise<void>,
  timer: CopyFeedbackTimer,
  setCopied: (copied: boolean) => void,
  durationMs: number,
): Promise<boolean> {
  try {
    await write(text);
  } catch {
    timer.dispose();
    setCopied(false);
    return false;
  }
  setCopied(true);
  timer.restart(() => setCopied(false), durationMs);
  return true;
}
