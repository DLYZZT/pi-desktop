export interface SkillInvocation {
  name: string;
  location: string;
  content: string;
  userMessage?: string;
}

/**
 * Parse the internal message shape Pi persists for an explicit
 * `/skill:<name>` invocation. Keep this in sync with Pi's parseSkillBlock().
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    ...(match[4]?.trim() ? { userMessage: match[4].trim() } : {}),
  };
}

/** Restore the user-facing slash command from Pi's persisted skill block. */
export function skillInvocationCommandText(text: string): string {
  const invocation = parseSkillInvocation(text);
  if (!invocation) return text;
  const command = `/skill:${invocation.name}`;
  return invocation.userMessage ? `${command} ${invocation.userMessage}` : command;
}
