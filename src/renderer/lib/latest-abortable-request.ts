export interface AbortableRequestToken {
  generation: number;
  signal: AbortSignal;
}

export class LatestAbortableRequest {
  private generation = 0;
  private active: { generation: number; controller: AbortController } | null = null;

  begin(): AbortableRequestToken {
    this.active?.controller.abort();
    const controller = new AbortController();
    this.generation += 1;
    this.active = { generation: this.generation, controller };
    return { generation: this.generation, signal: controller.signal };
  }

  isCurrent(generation: number): boolean {
    return this.active?.generation === generation && !this.active.controller.signal.aborted;
  }

  cancel(generation?: number): boolean {
    if (!this.active || (generation !== undefined && this.active.generation !== generation)) return false;
    this.active.controller.abort();
    this.active = null;
    this.generation += 1;
    return true;
  }

  finish(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.active = null;
    return true;
  }
}
