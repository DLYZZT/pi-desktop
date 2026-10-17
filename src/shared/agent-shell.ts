export type AgentShell = "bash" | "powershell";

export function isAgentShell(value: unknown): value is AgentShell {
  return value === "bash" || value === "powershell";
}

/** Selecting a shell changes the executor, never whether command execution is granted. */
export function useAgentShell(names: readonly string[], shell?: AgentShell): string[] {
  if (!shell || !names.some(isAgentShell)) return [...names];
  return [...new Set(names.map((name) => (isAgentShell(name) ? shell : name)))];
}

export interface AgentShellSettings {
  platform: string;
  shell: AgentShell;
}
