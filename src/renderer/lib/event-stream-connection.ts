export type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

export interface EventStreamConnectionResult {
  status: EventStreamConnectionStatus;
  unsubscribe: () => void;
}

type Unsubscribe = () => void;
type UnsubscribeRef = { current: Unsubscribe | null };

export class EventStreamConnectionManager {
  private generation = 0;
  private readonly target: UnsubscribeRef;

  constructor(target: UnsubscribeRef) {
    this.target = target;
  }

  begin(): number {
    this.generation += 1;
    this.clearCurrent();
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  install(generation: number, unsubscribe: Unsubscribe): Unsubscribe | null {
    const once = onceUnsubscribe(unsubscribe);
    if (!this.isCurrent(generation)) {
      once();
      return null;
    }
    this.target.current = once;
    return () => {
      if (!this.isCurrent(generation) || this.target.current !== once) return;
      this.generation += 1;
      this.target.current = null;
      once();
    };
  }

  invalidate(generation?: number): void {
    if (generation !== undefined && !this.isCurrent(generation)) return;
    this.generation += 1;
    this.clearCurrent();
  }

  private clearCurrent(): void {
    const current = this.target.current;
    this.target.current = null;
    current?.();
  }
}

export async function connectTimedEventStream<Event>(options: {
  manager: EventStreamConnectionManager;
  subscribe: (onEvent: (event: Event) => void) => Promise<Unsubscribe>;
  onEvent: (event: Event) => void;
  timeoutMs: number;
}): Promise<EventStreamConnectionResult> {
  const generation = options.manager.begin();
  const subscription = options
    .subscribe((event) => {
      if (options.manager.isCurrent(generation)) options.onEvent(event);
    })
    .then(
      (unsubscribe) => ({ status: "subscribed" as const, unsubscribe }),
      () => ({ status: "closed" as const }),
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    subscription,
    new Promise<{ status: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), options.timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (outcome.status === "timeout") {
    options.manager.invalidate(generation);
    void subscription.then((late) => {
      if (late.status === "subscribed") late.unsubscribe();
    });
    return { status: "timeout", unsubscribe: () => {} };
  }
  if (outcome.status === "closed") {
    options.manager.invalidate(generation);
    return { status: "closed", unsubscribe: () => {} };
  }
  const unsubscribe = options.manager.install(generation, outcome.unsubscribe);
  return unsubscribe ? { status: "connected", unsubscribe } : { status: "closed", unsubscribe: () => {} };
}

function onceUnsubscribe(unsubscribe: Unsubscribe): Unsubscribe {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    unsubscribe();
  };
}
