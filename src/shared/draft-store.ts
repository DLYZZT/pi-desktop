export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft | null>();
const LS_PREFIX = "pi-desktop-draft:";
export const MAX_PERSISTED_DRAFT_IMAGE_BYTES = 1.5 * 1024 * 1024;

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function persistKey(key: string): string {
  return LS_PREFIX + key;
}

export function decodedBase64ByteLength(data: string): number {
  const length = data.length;
  if (length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

export function persistableDraftImages(images: readonly ChatDraftImage[]): ChatDraftImage[] {
  let totalBytes = 0;
  for (const image of images) {
    totalBytes += decodedBase64ByteLength(image.data ?? "");
    if (totalBytes > MAX_PERSISTED_DRAFT_IMAGE_BYTES) return [];
  }
  return images.map((image) => ({ ...image }));
}

function loadFromStorage(key: string): ChatDraft | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(persistKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatDraft;
    if (!parsed || typeof parsed.value !== "string") return null;
    return {
      value: parsed.value,
      images: Array.isArray(parsed.images) ? parsed.images.slice(0, 4) : [],
    };
  } catch {
    return null;
  }
}

function saveToStorage(key: string, draft: ChatDraft | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (!draft || isEmptyDraft(draft)) {
      localStorage.removeItem(persistKey(key));
      return;
    }
    // Select images before JSON.stringify so oversized base64 is never included
    // in the synchronous serialization work performed on the renderer thread.
    const toStore: ChatDraft = {
      value: draft.value,
      images: persistableDraftImages(draft.images),
    };
    localStorage.setItem(persistKey(key), JSON.stringify(toStore));
  } catch {
    /* quota / private mode */
  }
}

export function getDraft(key: string): ChatDraft | null {
  if (drafts.has(key)) {
    const mem = drafts.get(key);
    return mem ? cloneDraft(mem) : null;
  }
  const stored = loadFromStorage(key);
  if (stored) {
    drafts.set(key, cloneDraft(stored));
    return cloneDraft(stored);
  }
  return null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.set(key, null);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function flushDraft(key: string): void {
  saveToStorage(key, drafts.get(key) ?? null);
}

export function clearDraft(key: string): void {
  drafts.set(key, null);
  saveToStorage(key, null);
}

interface DraftPersistenceDependencies {
  stage: (key: string, draft: ChatDraft) => void;
  flush: (key: string) => void;
  clear: (key: string) => void;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const browserPersistenceDependencies: DraftPersistenceDependencies = {
  stage: setDraft,
  flush: flushDraft,
  clear: clearDraft,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

export class DraftPersistenceController {
  private pendingKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly dependencies: DraftPersistenceDependencies;

  constructor(delayMs = 500, dependencies: DraftPersistenceDependencies = browserPersistenceDependencies) {
    this.delayMs = delayMs;
    this.dependencies = dependencies;
  }

  schedule(key: string, draft: ChatDraft): void {
    if (this.pendingKey && this.pendingKey !== key) this.flush();
    this.dependencies.stage(key, draft);
    this.pendingKey = key;
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null;
      const pendingKey = this.pendingKey;
      this.pendingKey = null;
      if (pendingKey) this.dependencies.flush(pendingKey);
    }, this.delayMs);
  }

  commit(key: string, draft: ChatDraft): void {
    if (this.pendingKey === key) {
      this.cancelTimer();
      this.pendingKey = null;
    } else {
      this.flush();
    }
    this.dependencies.stage(key, draft);
    this.dependencies.flush(key);
  }

  clear(key: string): void {
    if (this.pendingKey === key) {
      this.cancelTimer();
      this.pendingKey = null;
    }
    this.dependencies.clear(key);
  }

  flush(): void {
    this.cancelTimer();
    const pendingKey = this.pendingKey;
    this.pendingKey = null;
    if (pendingKey) this.dependencies.flush(pendingKey);
  }

  dispose(): void {
    this.flush();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.dependencies.clearTimer(this.timer);
    this.timer = null;
  }
}
