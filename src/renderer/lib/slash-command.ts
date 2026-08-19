export interface SlashQueryMatch {
  /** Index of the "/" that starts the command token */
  start: number;
  /** Text typed after the "/", may be empty */
  query: string;
}

/**
 * Detect a slash-command token immediately before the cursor. The "/" must be
 * at the start of the text or preceded by whitespace, so paths like src/foo
 * and URLs like https://example never trigger.
 */
export function extractSlashQuery(textBeforeCursor: string): SlashQueryMatch | null {
  const match = /(?:^|\s)\/(\S*)$/.exec(textBeforeCursor);
  if (!match) return null;
  return {
    start: textBeforeCursor.length - (match[1].length + 1),
    query: match[1],
  };
}

/**
 * Replace the typed slash token with `/${commandName}` and keep the rest of
 * the draft as command args. Commands must start the message to run, so the
 * result is always prefixed.
 */
export function filterSlashItems<T extends { name: string; description?: string }>(items: T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(q) || (item.description ?? "").toLowerCase().includes(q),
  );
}

export function applySlashPrefix(value: string, match: SlashQueryMatch, commandName: string): string {
  const before = value.slice(0, match.start).trim();
  const after = value.slice(match.start + 1 + match.query.length).trim();
  const rest = [before, after].filter(Boolean).join(" ");
  return rest ? `/${commandName} ${rest}` : `/${commandName} `;
}
