import type { SlashCommandInfo } from "../contract/agent-commands";
const pendingProviders = new WeakMap<(prefix: string) => unknown, Promise<unknown>>();
export async function commandArgumentCompletions(
  input: string,
  commands: Array<{
    invocationName: string;
    sourceInfo?: SlashCommandInfo["sourceInfo"];
    getArgumentCompletions?: (prefix: string) => unknown;
  }>,
): Promise<SlashCommandInfo[]> {
  const match = /^\/(\S+) (.*)$/s.exec(input);
  if (!match) return [];
  const command = commands.find((item) => item.invocationName === match[1]);
  if (!command?.getArgumentCompletions) return [];
  const provider = command.getArgumentCompletions;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const items = await Promise.race([
      Promise.resolve().then(async () => {
        while (pendingProviders.has(provider)) await pendingProviders.get(provider)?.catch(() => {});
        if (expired) return null;
        const work = Promise.resolve().then(() => provider.call(command, match[2]));
        pendingProviders.set(provider, work);
        try {
          return await work;
        } finally {
          pendingProviders.delete(provider);
        }
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(null);
        }, 1000);
      }),
    ]);
    if (!Array.isArray(items)) return [];
    return items
      .slice(0, 100)
      .filter(
        (item) => item && typeof item.value === "string" && typeof item.label === "string" && item.value !== match[2],
      )
      .map((item) => ({
        name: `${command.invocationName} ${item.value}`,
        label: `${command.invocationName} ${item.label}`,
        description: typeof item.description === "string" ? item.description : undefined,
        source: "extension",
        sourceInfo: command.sourceInfo,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
