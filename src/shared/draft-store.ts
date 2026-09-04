export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraftFile {
  name: string;
  path: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files?: ChatDraftFile[];
}

interface PersistedChatDraftV2 {
  schemaVersion: typeof CHAT_DRAFT_SCHEMA_VERSION;
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
  updatedAt: number;
}

const drafts = new Map<string, ChatDraft | null>();
const LS_PREFIX = "pi-desktop-draft:";
export const CHAT_DRAFT_SCHEMA_VERSION = 2;
export const MAX_PERSISTED_DRAFT_IMAGES = 4;
export const MAX_PERSISTED_DRAFT_FILES = 8;
// Decoded image bytes stored in localStorage. Electron's quota is typically ~10MB;
// 4MB decoded (~5.3MB JSON) leaves headroom for text drafts and other keys.
// Attachments are compressed first so typical retina / screenshot-tool PNGs fit.
export const MAX_PERSISTED_DRAFT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DRAFT_FILE_NAME_CHARS = 512;
export const MAX_DRAFT_FILE_PATH_CHARS = 32_768;

export type DraftImageRejectionReason = "count" | "bytes";

export interface DraftImageAdditionSelection<T extends ChatDraftImage> {
  accepted: T[];
  rejected: Array<{ image: T; reason: DraftImageRejectionReason }>;
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: (draft.files ?? []).map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && (draft.files?.length ?? 0) === 0;
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

export function selectDraftImageAdditions<T extends ChatDraftImage>(
  existing: readonly ChatDraftImage[],
  candidates: readonly T[],
): DraftImageAdditionSelection<T> {
  const accepted: T[] = [];
  const rejected: Array<{ image: T; reason: DraftImageRejectionReason }> = [];
  let totalBytes = existing.reduce((total, image) => total + decodedBase64ByteLength(image.data), 0);
  for (const image of candidates) {
    if (existing.length + accepted.length >= MAX_PERSISTED_DRAFT_IMAGES) {
      rejected.push({ image, reason: "count" });
      continue;
    }
    const nextBytes = totalBytes + decodedBase64ByteLength(image.data);
    if (nextBytes > MAX_PERSISTED_DRAFT_IMAGE_BYTES) {
      rejected.push({ image, reason: "bytes" });
      continue;
    }
    accepted.push(image);
    totalBytes = nextBytes;
  }
  return { accepted, rejected };
}

export function persistableDraftImages(images: readonly ChatDraftImage[]): ChatDraftImage[] {
  let totalBytes = 0;
  const selected: ChatDraftImage[] = [];
  for (const image of images.slice(0, MAX_PERSISTED_DRAFT_IMAGES)) {
    if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
    if (!image.mimeType.toLowerCase().startsWith("image/")) continue;
    totalBytes += decodedBase64ByteLength(image.data ?? "");
    if (totalBytes > MAX_PERSISTED_DRAFT_IMAGE_BYTES) return [];
    selected.push({ data: image.data, mimeType: image.mimeType });
  }
  return selected;
}

export function isAbsoluteDraftFilePath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || filePath.length > MAX_DRAFT_FILE_PATH_CHARS) return false;
  return (
    filePath.startsWith("/") ||
    filePath.startsWith("\\\\") ||
    filePath.startsWith("//") ||
    /^[a-zA-Z]:[\\/]/.test(filePath)
  );
}

function draftFileDedupeKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function persistableDraftFiles(files: readonly ChatDraftFile[]): ChatDraftFile[] {
  const selected: ChatDraftFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (selected.length >= MAX_PERSISTED_DRAFT_FILES) break;
    if (!file || typeof file.name !== "string" || typeof file.path !== "string") continue;
    const name = file.name.trim();
    if (!name || name.length > MAX_DRAFT_FILE_NAME_CHARS || !isAbsoluteDraftFilePath(file.path)) continue;
    const key = draftFileDedupeKey(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ name, path: file.path });
  }
  return selected;
}

function loadFromStorage(key: string): ChatDraft | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(persistKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedChatDraftV2> & { schemaVersion?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.value !== "string") return null;
    // Missing schemaVersion is the legacy v1 shape. Unknown future versions
    // must not be interpreted as the current schema.
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== CHAT_DRAFT_SCHEMA_VERSION) return null;
    return {
      value: parsed.value,
      images: persistableDraftImages(Array.isArray(parsed.images) ? parsed.images : []),
      files: persistableDraftFiles(Array.isArray(parsed.files) ? parsed.files : []),
    };
  } catch {
    return null;
  }
}

function saveToStorage(key: string, draft: ChatDraft | null): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    if (!draft || isEmptyDraft(draft)) {
      localStorage.removeItem(persistKey(key));
      return true;
    }
    // Select images before JSON.stringify so oversized base64 is never included
    // in the synchronous serialization work performed on the renderer thread.
    const images = persistableDraftImages(draft.images);
    const files = persistableDraftFiles(draft.files ?? []);
    const toStore: PersistedChatDraftV2 = {
      schemaVersion: CHAT_DRAFT_SCHEMA_VERSION,
      value: draft.value,
      images,
      files,
      updatedAt: Date.now(),
    };
    localStorage.setItem(persistKey(key), JSON.stringify(toStore));
    // The text and valid references are still saved, but report the partial
    // persistence so the composer can tell the user that some attachments
    // will not survive a reload.
    return images.length === draft.images.length && files.length === (draft.files?.length ?? 0);
  } catch {
    return false;
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

export function flushDraft(key: string): boolean {
  return saveToStorage(key, drafts.get(key) ?? null);
}

export function clearDraft(key: string): boolean {
  drafts.set(key, null);
  return saveToStorage(key, null);
}

interface DraftPersistenceDependencies {
  stage: (key: string, draft: ChatDraft) => void;
  flush: (key: string) => boolean | void;
  clear: (key: string) => boolean | void;
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
  private readonly onPersistenceError?: (key: string) => void;

  constructor(
    delayMs = 500,
    dependencies: DraftPersistenceDependencies = browserPersistenceDependencies,
    onPersistenceError?: (key: string) => void,
  ) {
    this.delayMs = delayMs;
    this.dependencies = dependencies;
    this.onPersistenceError = onPersistenceError;
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
      if (pendingKey) this.flushKey(pendingKey);
    }, this.delayMs);
  }

  commit(key: string, draft: ChatDraft): boolean {
    if (this.pendingKey === key) {
      this.cancelTimer();
      this.pendingKey = null;
    } else {
      this.flush();
    }
    this.dependencies.stage(key, draft);
    return this.flushKey(key);
  }

  clear(key: string): boolean {
    if (this.pendingKey === key) {
      this.cancelTimer();
      this.pendingKey = null;
    }
    const result = this.dependencies.clear(key);
    if (result === false) this.onPersistenceError?.(key);
    return result !== false;
  }

  flush(): boolean {
    this.cancelTimer();
    const pendingKey = this.pendingKey;
    this.pendingKey = null;
    return pendingKey ? this.flushKey(pendingKey) : true;
  }

  dispose(): boolean {
    return this.flush();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.dependencies.clearTimer(this.timer);
    this.timer = null;
  }

  private flushKey(key: string): boolean {
    const result = this.dependencies.flush(key);
    if (result === false) this.onPersistenceError?.(key);
    return result !== false;
  }
}
