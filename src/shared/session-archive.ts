export const SESSION_ARCHIVE_CUSTOM_TYPE = "desktop.archived";

export function readSessionArchived(entries: Array<{ type?: string; customType?: string; data?: unknown }>): boolean {
  let archived = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ARCHIVE_CUSTOM_TYPE) continue;
    archived = Boolean((entry.data as { archived?: unknown } | undefined)?.archived);
  }
  return archived;
}

export function forkSessionInfoPatch(entries: Array<{ type?: string; customType?: string; data?: unknown }>): {
  archived?: true;
} {
  return readSessionArchived(entries) ? { archived: true } : {};
}
