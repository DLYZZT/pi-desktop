/** Native Windows processes must not inherit MSYS shell patches or duplicate case-folded variables. */
export function mcpProcessEnvironment(
  platform: NodeJS.Platform,
  context: { nativeEnv: NodeJS.ProcessEnv; shellEnv: NodeJS.ProcessEnv },
  overrides: NodeJS.ProcessEnv,
): Record<string, string> {
  const values = new Map<string, [string, string]>();
  for (const source of [platform === "win32" ? context.nativeEnv : context.shellEnv, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      const folded = platform === "win32" ? key.toLowerCase() : key;
      if (typeof value !== "string" || folded.toLowerCase() === "electron_run_as_node") continue;
      values.set(folded, [key, value]);
    }
  }
  return Object.fromEntries(values.values());
}
