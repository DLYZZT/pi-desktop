import type { SessionInfo } from "./types";
import { applySessionChangedEvent, type SessionChangedEvent } from "./session-sidebar-state.ts";

export interface SessionListData {
  sessions: SessionInfo[];
  runningSessionIds?: string[];
}

export interface SessionListSnapshot {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  loading: boolean;
  error: unknown;
  live: boolean;
  projectInfoRevision: number;
}

type Read = {
  scope: object;
  changes: Map<string, SessionChangedEvent>;
  again: boolean;
  promise: Promise<SessionInfo[]>;
};

/** Window-scoped session index. Chat history and running events have separate owners. */
export class SessionListStore {
  private snapshot: SessionListSnapshot = {
    sessions: [],
    runningSessionIds: [],
    loading: true,
    error: null,
    live: false,
    projectInfoRevision: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly deletedListeners = new Set<(id: string) => void>();
  private readonly deletedIds = new Set<string>();
  private scope: object | null = null;
  private read: Read | null = null;
  private readonly load: () => Promise<SessionListData>;

  constructor(load: () => Promise<SessionListData>) {
    this.load = load;
  }

  getSnapshot = (): SessionListSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeDeleted = (listener: (id: string) => void): (() => void) => {
    this.deletedListeners.add(listener);
    return () => {
      this.deletedListeners.delete(listener);
    };
  };

  activate(): () => void {
    const scope = {};
    this.scope = scope;
    this.read = null;
    this.publish({ live: false });
    return () => {
      if (this.scope !== scope) return;
      this.scope = null;
      this.read = null;
    };
  }

  setLive(live: boolean): void {
    if (this.scope) this.publish({ live });
  }

  refresh = (showLoading = false): Promise<SessionInfo[]> => {
    if (!this.scope) return Promise.resolve(this.snapshot.sessions);
    if (this.read) {
      if (showLoading) this.publish({ loading: true });
      return this.read.promise;
    }
    const read: Read = { scope: this.scope, changes: new Map(), again: false, promise: Promise.resolve([]) };
    this.read = read;
    // Install ownership before the loader can resolve or synchronously emit an event.
    read.promise = Promise.resolve().then(() => this.performRead(read));
    if (showLoading) this.publish({ loading: true });
    return read.promise;
  };

  /** An unknown change during a read requires one subsequent read, not a parallel request. */
  invalidate = (): void => {
    if (!this.scope) return;
    if (this.read) this.read.again = true;
    else void this.refresh().catch(() => {});
  };

  refreshIfDisconnected = (): void => {
    if (!this.snapshot.live) this.invalidate();
  };

  async findSession(id: string): Promise<SessionInfo | undefined> {
    const cached = this.snapshot.sessions.find((session) => session.id === id);
    if (cached?.projectRoot) return cached;
    return (await this.refresh()).find((session) => session.id === id);
  }

  applyChange = (event: SessionChangedEvent): void => {
    if (!this.scope) return;
    if (event.projectInfoChanged) this.publish({ projectInfoRevision: this.snapshot.projectInfoRevision + 1 });
    const sessions = applySessionChangedEvent(this.snapshot.sessions, event);
    if (sessions === null) {
      this.invalidate();
      return;
    }
    const id = event.deleted ? event.sessionId : event.session?.id;
    if (id) this.read?.changes.set(id, event);
    this.publish({ sessions });
    if (event.deleted && id) {
      if (!this.deletedIds.has(id)) {
        this.deletedIds.add(id);
        for (const listener of [...this.deletedListeners]) listener(id);
      }
    } else if (id) {
      this.deletedIds.delete(id);
    }
  };

  private async performRead(read: Read): Promise<SessionInfo[]> {
    try {
      while (this.read === read && this.scope === read.scope) {
        read.again = false;
        read.changes.clear();
        try {
          const data = await this.load();
          if (this.read !== read || this.scope !== read.scope) break;
          if (read.again) continue;
          let sessions = data.sessions;
          for (const change of read.changes.values()) sessions = applySessionChangedEvent(sessions, change) ?? sessions;
          for (const session of sessions) this.deletedIds.delete(session.id);
          this.publish({ sessions, runningSessionIds: data.runningSessionIds ?? [], error: null });
        } catch (error) {
          if (this.read !== read || this.scope !== read.scope) break;
          if (read.again) continue;
          this.publish({ error });
          throw error;
        }
        if (!read.again) break;
      }
    } finally {
      if (this.read === read && this.scope === read.scope) {
        this.read = null;
        this.publish({ loading: false });
      }
    }
    return this.snapshot.sessions;
  }

  private publish(patch: Partial<SessionListSnapshot>): void {
    if (Object.entries(patch).every(([key, value]) => this.snapshot[key as keyof SessionListSnapshot] === value))
      return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
