export const UNREAD_SESSIONS_STORAGE_KEY = "pi-desktop:unread-session-ids";
export const LEGACY_UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";

export type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseSessionIds(raw: string | null): Set<string> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function loadUnreadSessionIds(storage: SessionStorage): Set<string> {
  const current = parseSessionIds(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
  if (current !== null) {
    storage.removeItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
    return current;
  }

  const legacy = parseSessionIds(storage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY));
  if (legacy === null) return new Set();

  if (legacy.size > 0) storage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...legacy]));
  storage.removeItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
  return legacy;
}

export function saveUnreadSessionIds(storage: SessionStorage, ids: ReadonlySet<string>): void {
  if (ids.size === 0) storage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
  else storage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  storage.removeItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
}
