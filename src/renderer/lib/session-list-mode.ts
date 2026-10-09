import { DEFAULT_SESSION_LIST_MODE, isSessionListMode, type SessionListMode } from "@shared/session-list-mode";

export interface SessionListModeSnapshot {
  mode: SessionListMode;
  loaded: boolean;
  saving: boolean;
}

export interface SessionListModeControllerDependencies {
  read: () => Promise<unknown>;
  write: (mode: SessionListMode) => Promise<void>;
}

/**
 * Module-level owner of the session list mode preference. A single instance is
 * shared by the sidebar (consumer) and the settings section (editor) so a
 * change in one place is reflected everywhere without prop drilling.
 */
export class SessionListModeController {
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SessionListModeSnapshot => this.snapshot;

  private snapshot: SessionListModeSnapshot = {
    mode: DEFAULT_SESSION_LIST_MODE,
    loaded: false,
    saving: false,
  };
  private committed: SessionListMode = DEFAULT_SESSION_LIST_MODE;
  private loadPromise: Promise<void> | null = null;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly dependencies: SessionListModeControllerDependencies;

  constructor(dependencies: SessionListModeControllerDependencies) {
    this.dependencies = dependencies;
  }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.dependencies
      .read()
      .then((value) => this.commitLoaded(isSessionListMode(value) ? value : DEFAULT_SESSION_LIST_MODE))
      .catch(() => this.commitLoaded(DEFAULT_SESSION_LIST_MODE));
    return this.loadPromise;
  }

  async update(mode: SessionListMode): Promise<void> {
    if (!isSessionListMode(mode)) throw new TypeError("Invalid session list mode");
    const revision = ++this.revision;
    this.publish({ mode, loaded: true, saving: true });
    try {
      await this.dependencies.write(mode);
      this.committed = mode;
      if (revision === this.revision) this.publish({ mode, loaded: true, saving: false });
    } catch (error) {
      if (revision === this.revision) this.publish({ mode: this.committed, loaded: true, saving: false });
      throw error;
    }
  }

  private commitLoaded(mode: SessionListMode): void {
    this.committed = mode;
    this.publish({ mode, loaded: true, saving: false });
  }

  private publish(snapshot: SessionListModeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const sessionListModeController = new SessionListModeController({
  read: async () => (await window.piBridge.getUiState()).sessionListMode,
  write: (mode) => window.piBridge.setUiState({ sessionListMode: mode }),
});
