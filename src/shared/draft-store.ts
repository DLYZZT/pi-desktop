export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const LS_PREFIX = "pi-desktop-draft:";
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // skip persisting huge images

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
    // ISSUE-006: persist text; images only if small enough (base64 size proxy)
    const imageBytes = draft.images.reduce((n, img) => n + (img.data?.length ?? 0), 0);
    const toStore: ChatDraft = {
      value: draft.value,
      images: imageBytes <= MAX_IMAGE_BYTES ? draft.images : [],
    };
    localStorage.setItem(persistKey(key), JSON.stringify(toStore));
  } catch {
    /* quota / private mode */
  }
}

export function getDraft(key: string): ChatDraft | null {
  const mem = drafts.get(key);
  if (mem) return cloneDraft(mem);
  const stored = loadFromStorage(key);
  if (stored) {
    drafts.set(key, cloneDraft(stored));
    return cloneDraft(stored);
  }
  return null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    saveToStorage(key, null);
    return;
  }
  const cloned = cloneDraft(draft);
  drafts.set(key, cloned);
  saveToStorage(key, cloned);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  saveToStorage(key, null);
}
