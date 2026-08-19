import {
  DEFAULT_CHAT_APPEARANCE,
  normalizeChatAppearance,
  type ChatAppearancePreferences,
} from "../../shared/chat-appearance.ts";

export interface ChatAppearanceAttributeTarget {
  dataset: {
    chatFontSize?: string;
    chatLayout?: string;
  };
}

export interface ChatAppearanceSnapshot {
  preferences: ChatAppearancePreferences;
  loaded: boolean;
  saving: boolean;
}

export interface ChatAppearanceControllerDependencies {
  read: () => Promise<unknown>;
  write: (preferences: ChatAppearancePreferences) => Promise<void>;
  apply: (preferences: ChatAppearancePreferences) => void;
}

export function applyChatAppearance(
  target: ChatAppearanceAttributeTarget,
  preferences: ChatAppearancePreferences,
): void {
  const normalized = normalizeChatAppearance(preferences);
  target.dataset.chatFontSize = normalized.fontSize;
  target.dataset.chatLayout = normalized.layout;
}

export function scaledChatFont(px: number): string {
  return `calc(${px}px * var(--chat-font-scale, 1))`;
}

export class ChatAppearanceController {
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ChatAppearanceSnapshot => this.snapshot;

  private snapshot: ChatAppearanceSnapshot = {
    preferences: { ...DEFAULT_CHAT_APPEARANCE },
    loaded: false,
    saving: false,
  };
  private committed = { ...DEFAULT_CHAT_APPEARANCE };
  private loadPromise: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly dependencies: ChatAppearanceControllerDependencies;

  constructor(dependencies: ChatAppearanceControllerDependencies) {
    this.dependencies = dependencies;
  }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.dependencies
      .read()
      .then((value) => this.commitLoaded(normalizeChatAppearance(value)))
      .catch(() => this.commitLoaded({ ...DEFAULT_CHAT_APPEARANCE }));
    return this.loadPromise;
  }

  async update(preferences: ChatAppearancePreferences): Promise<void> {
    const next = normalizeChatAppearance(preferences);
    const revision = ++this.revision;
    this.dependencies.apply(next);
    this.publish({ preferences: next, loaded: true, saving: true });

    const operation = this.persistQueue.catch(() => undefined).then(() => this.dependencies.write(next));
    this.persistQueue = operation;

    try {
      await operation;
      this.committed = next;
      if (revision === this.revision) this.publish({ preferences: next, loaded: true, saving: false });
    } catch (error) {
      if (revision === this.revision) {
        this.dependencies.apply(this.committed);
        this.publish({ preferences: this.committed, loaded: true, saving: false });
      }
      throw error;
    }
  }

  private commitLoaded(preferences: ChatAppearancePreferences): void {
    this.committed = preferences;
    this.dependencies.apply(preferences);
    this.publish({ preferences, loaded: true, saving: false });
  }

  private publish(snapshot: ChatAppearanceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
