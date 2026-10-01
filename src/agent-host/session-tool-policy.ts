import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ToolInfo } from "../shared/pi-types";
import { EXCLUDED_PI_TOOLS, filterDesktopToolNames } from "../shared/pi-tool-policy";
import { getAgentSessionSource } from "./session-source";
import { isHerdrToolName } from "./herdr/tool-names";
import { isManagedProcessToolName } from "./managed-process/tool-names";
import { CODING_TOOL_NAMES } from "./tool-activation";
import { isMcpManagedTool } from "../shared/mcp-tool-policy";
import { isOrchestrationTool } from "../shared/orchestration-tools";

/** A Desktop grant is independent from SDK declaration/callable membership. */
export class SessionToolPolicy {
  private session?: AgentSessionLike;
  private initialActive = new Set<string>();
  private mcpAuthorizer?: (
    name: string,
    input: unknown,
    ctx: ExtensionContext,
    valid: () => boolean,
  ) => Promise<boolean>;
  setMcpAuthorizer(authorizer: typeof this.mcpAuthorizer): void {
    this.mcpAuthorizer = authorizer;
  }
  constructor(
    private readonly manager: object,
    private requested?: string[],
    private execution?: string[],
    private mcpExecution?: string[],
  ) {}
  bind(session: AgentSessionLike): void {
    this.session = session;
    this.initialActive = new Set(session.getActiveToolNames());
  }
  setRequested(names: string[]): void {
    const wasEmpty = this.requested?.length === 0;
    this.requested = [...names];
    if (names.length === 0) this.execution = [];
    else if (wasEmpty) this.execution = undefined;
    if (names.length === 0) this.mcpExecution = [];
    else if (wasEmpty) this.mcpExecution = undefined;
  }
  isEmpty(): boolean {
    return this.requested?.length === 0;
  }
  setMcpExecution(names: string[]): void {
    this.mcpExecution = [...names];
  }
  getMcpExecution(): string[] | undefined {
    return this.mcpExecution ? [...this.mcpExecution] : undefined;
  }
  setExecution(names: string[]): void {
    this.execution = filterDesktopToolNames(names);
    this.mcpExecution = undefined;
  }
  getExecution(): string[] | undefined {
    return this.execution ? [...this.execution] : undefined;
  }
  isAllowed(name: string): boolean {
    if (!this.session || this.requested?.length === 0 || EXCLUDED_PI_TOOLS.includes(name)) return false;
    const source = getAgentSessionSource(this.manager);
    if (source === "unknown") return false;
    if (source === "channel" && (isHerdrToolName(name) || isManagedProcessToolName(name))) return false;
    const tool =
      this.session.getToolDefinition?.(name) ?? this.session.getAllTools().find((entry) => entry.name === name);
    if (!tool || tool.exposure === "hidden") return false;
    if (source === "local" && isOrchestrationTool(name)) return this.session.getActiveToolNames().includes(name);
    if (isOrchestrationTool(name))
      return (
        (this.mcpExecution ?? this.execution ?? this.requested)?.includes(name) === true &&
        this.session.getActiveToolNames().includes(name)
      );
    if (isMcpManagedTool(name)) {
      if (this.mcpExecution !== undefined) return this.mcpExecution.includes(name);
      if (this.execution !== undefined) return this.execution.includes(name);
      return this.requested?.includes(name) === true && this.session.getActiveToolNames().includes(name);
    }
    if (CODING_TOOL_NAMES.has(name))
      return (
        (this.requested ? this.requested.includes(name) : this.initialActive.has(name)) &&
        this.session.getActiveToolNames().includes(name)
      );
    if (this.execution !== undefined) return this.execution.includes(name);
    if (tool.exposure === "codemode" || tool.exposure === "deferred") return false;
    const explicit = this.requested?.includes(name) === true;
    return (
      this.session.getActiveToolNames().includes(name) &&
      (explicit || this.session.getToolDefinition?.(name)?.defaultActive !== false)
    );
  }
  describe(): ToolInfo[] {
    if (!this.session) return [];
    const active = new Set(this.session.getActiveToolNames());
    const callable = new Set(this.session.getCallableToolNames?.() ?? this.session.getActiveToolNames());
    return this.session
      .getAllTools()
      .filter((tool) => tool.exposure !== "hidden")
      .map((tool) => ({
        ...tool,
        active: active.has(tool.name),
        callable: callable.has(tool.name),
        executionAllowed: this.isAllowed(tool.name),
      }));
  }
  extension() {
    return {
      name: "pi-desktop-tool-execution-policy",
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        pi.on("tool_call", async (event, ctx) => {
          if (this.isAllowed(event.toolName)) return;
          const tool = this.session?.getAllTools().find((entry) => entry.name === event.toolName);
          if (
            !this.isEmpty() &&
            getAgentSessionSource(this.manager) === "local" &&
            ctx.hasUI &&
            tool &&
            tool.exposure !== "hidden" &&
            isMcpManagedTool(event.toolName)
          ) {
            const approved = await this.mcpAuthorizer?.(
              event.toolName,
              event.input,
              ctx,
              () => !this.isEmpty() && getAgentSessionSource(this.manager) === "local",
            );
            if (approved && getAgentSessionSource(this.manager) === "local" && this.isAllowed(event.toolName)) return;
          }
          return {
            block: true,
            reason: `TOOL_PERMISSION_DENIED: ${event.toolName} is not authorized for this session/source`,
          };
        });
      },
    };
  }
}
