/** Runtime snapshots need field-level ordering: a queue event must not discard
 * the only initial run snapshot, while an old queue snapshot must not win. */
export type RuntimeField =
  "run" | "queue" | "compaction" | "statuses" | "widgets" | "thinking" | "usage" | "systemPrompt";
type Versions = Record<RuntimeField, number>;
export interface RuntimeSnapshotTicket {
  readonly run: number;
  readonly sequence: number;
  readonly versions: Versions;
}

export class SessionRuntimeGate {
  private run = 0;
  private sequence = 0;
  private versions: Versions = {
    run: 0,
    queue: 0,
    compaction: 0,
    statuses: 0,
    widgets: 0,
    thinking: 0,
    usage: 0,
    systemPrompt: 0,
  };
  private applied: Partial<Versions> = {};

  beginRun(): void {
    this.run++;
  }
  touch(field: RuntimeField): void {
    this.versions[field]++;
  }
  capture(): RuntimeSnapshotTicket {
    return { run: this.run, sequence: ++this.sequence, versions: { ...this.versions } };
  }
  isCurrentRun(ticket: RuntimeSnapshotTicket): boolean {
    return ticket.run === this.run;
  }
  isCurrent(ticket: RuntimeSnapshotTicket, field: RuntimeField): boolean {
    return (
      this.isCurrentRun(ticket) &&
      ticket.versions[field] === this.versions[field] &&
      ticket.sequence >= (this.applied[field] ?? 0)
    );
  }
  accept(ticket: RuntimeSnapshotTicket, field: RuntimeField): boolean {
    if (!this.isCurrent(ticket, field)) return false;
    this.applied[field] = ticket.sequence;
    return true;
  }
}
