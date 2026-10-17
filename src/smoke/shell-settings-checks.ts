import type { AgentShell, AgentShellSettings } from "../shared/agent-shell";
type Call = <T = unknown>(method: string, params?: unknown) => Promise<T>;
type Tool = { name: string; active: boolean; executionAllowed?: boolean };

/** Exercise real Host allocation and reload without sending any model prompt. */
export async function runShellSettingsChecks(call: Call, cwd: string): Promise<void> {
  if (process.platform !== "win32") return;
  const previous = await call<AgentShellSettings>("settings.getAgentShell");
  const command = (sessionId: string, command: Record<string, unknown>) =>
    call("agent.command", { sessionId, command });
  const verify = async (sessionId: string, shell: AgentShell, enabled = true) => {
    const tools = (await command(sessionId, { type: "get_tools" })) as Tool[];
    for (const name of ["bash", "powershell"]) {
      const tool = tools.find((entry) => entry.name === name);
      if (
        !tool ||
        tool.active !== (enabled && name === shell) ||
        Boolean(tool.executionAllowed) !== (enabled && name === shell)
      )
        throw new Error(`Unexpected shell grant: ${name}, expected ${shell}/${enabled}`);
    }
  };
  try {
    await call("settings.setAgentShell", { shell: "powershell" });
    const first = await call<{ sessionId: string }>("agent.new", {
      cwd,
      type: "ensure_session",
      toolNames: ["read", "bash", "powershell"],
    });
    await verify(first.sessionId, "powershell");
    await call("settings.setAgentShell", { shell: "bash" });
    const second = await call<{ sessionId: string }>("agent.new", {
      cwd,
      type: "ensure_session",
      toolNames: ["read", "bash", "powershell"],
    });
    await verify(second.sessionId, "bash");
    await command(first.sessionId, { type: "reload" });
    await verify(first.sessionId, "powershell");
    await command(first.sessionId, { type: "set_tools", toolNames: [] });
    await verify(first.sessionId, "powershell", false);
    await command(first.sessionId, { type: "set_tools", toolNames: ["read", "bash", "powershell"] });
    await verify(first.sessionId, "powershell");
    const disabled = await call<{ sessionId: string }>("agent.new", { cwd, type: "ensure_session", toolNames: [] });
    await verify(disabled.sessionId, "bash", false);
    console.log(
      "Agent shell settings passed: new-session default, mutual exclusion, existing-session reload, no-tools and preset restoration; no model prompts",
    );
  } finally {
    await call("settings.setAgentShell", { shell: previous.shell });
  }
}
