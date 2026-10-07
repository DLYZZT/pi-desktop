import {
  createBashToolDefinition,
  type CreateAgentSessionFromServicesOptions,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { toolchainRuntime } from "./toolchain-runtime";
import { createToolchainBashOptions } from "./toolchain-bash";
import { createDesktopSearchToolDefinitions } from "./toolchain-search";
import { createBrowserToolDefinitions } from "./browser-tools";
import { browserAgentRuntime } from "./browser-agent-runtime";
import { peekHerdrBridge } from "./herdr/runtime";
import { createHerdrToolDefinitions } from "./herdr/tools";
import { peekManagedProcessService } from "./managed-process/runtime";
import { createManagedProcessToolDefinitions } from "./managed-process/tools";
import type { SessionExecutionHistory } from "./session-execution-history";

export async function createDesktopSessionTools(
  cwd: string,
  manager: SessionManager,
  settings: SettingsManager,
  history: SessionExecutionHistory,
) {
  const executionContext = await toolchainRuntime.createExecutionContext({
    cwd,
    intent: "agent-shell",
    trusted: settings.isProjectTrusted(),
  });
  const bashOptions = createToolchainBashOptions(
    executionContext,
    toolchainRuntime,
    settings.getShellCommandPrefix(),
    (command) => browserAgentRuntime.guardBash(manager.getSessionId(), command),
  );
  const customTools = [
    history.tool(),
    createBashToolDefinition(cwd, bashOptions),
    ...createDesktopSearchToolDefinitions(cwd, executionContext, toolchainRuntime),
    ...createBrowserToolDefinitions(),
    ...(peekHerdrBridge() ? [...createHerdrToolDefinitions(cwd, peekHerdrBridge()!)] : []),
    ...(peekManagedProcessService()
      ? createManagedProcessToolDefinitions(cwd, settings.isProjectTrusted(), peekManagedProcessService()!)
      : []),
  ] as unknown as NonNullable<CreateAgentSessionFromServicesOptions["customTools"]>;
  return { executionContext, customTools };
}
