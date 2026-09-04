import { HERDR_STARTABLE_AGENT_KINDS, type HerdrStartableAgentKind } from "../../contract/herdr.ts";
export { HERDR_STARTABLE_AGENT_KINDS } from "../../contract/herdr.ts";

export type AgentCliRuntimeHint = "node" | "bun" | "python";

export type AgentCliEnvironmentDirectory = {
  key: string;
  suffix?: readonly string[];
};

export type AgentCliCatalogEntry = {
  kind: HerdrStartableAgentKind;
  command: HerdrStartableAgentKind;
  posixHomeRelativeDirectories: readonly (readonly string[])[];
  windowsHomeRelativeDirectories: readonly (readonly string[])[];
  windowsLocalAppDataRelativeDirectories: readonly (readonly string[])[];
  environmentDirectories: readonly AgentCliEnvironmentDirectory[];
  runtimeHints: readonly AgentCliRuntimeHint[];
};

export const HERDR_AGENT_CLI_CATALOG = [
  {
    kind: "pi",
    command: "pi",
    posixHomeRelativeDirectories: [
      [".local", "bin"],
      [".pi", "agent", "bin"],
    ],
    windowsHomeRelativeDirectories: [
      [".local", "bin"],
      [".pi", "agent", "bin"],
    ],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [{ key: "PI_CODING_AGENT_DIR", suffix: ["bin"] }],
    runtimeHints: ["node", "bun"],
  },
  {
    kind: "claude",
    command: "claude",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [[".local", "bin"]],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [],
    runtimeHints: [],
  },
  {
    kind: "codex",
    command: "codex",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [[".local", "bin"]],
    windowsLocalAppDataRelativeDirectories: [["Programs", "OpenAI", "Codex", "bin"]],
    environmentDirectories: [{ key: "CODEX_INSTALL_DIR" }],
    runtimeHints: ["node"],
  },
  {
    kind: "gemini",
    command: "gemini",
    posixHomeRelativeDirectories: [],
    windowsHomeRelativeDirectories: [],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [],
    runtimeHints: ["node"],
  },
  {
    kind: "omp",
    command: "omp",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [],
    windowsLocalAppDataRelativeDirectories: [["omp"]],
    environmentDirectories: [{ key: "PI_INSTALL_DIR" }],
    runtimeHints: ["bun"],
  },
  {
    kind: "opencode",
    command: "opencode",
    posixHomeRelativeDirectories: [[".opencode", "bin"]],
    windowsHomeRelativeDirectories: [[".opencode", "bin"]],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [],
    runtimeHints: ["node", "bun"],
  },
  {
    kind: "copilot",
    command: "copilot",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [],
    runtimeHints: ["node"],
  },
  {
    kind: "kimi",
    command: "kimi",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [[".local", "bin"]],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [{ key: "UV_TOOL_BIN_DIR" }, { key: "XDG_BIN_HOME" }],
    runtimeHints: ["python"],
  },
  {
    kind: "droid",
    command: "droid",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [["bin"]],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [],
    runtimeHints: [],
  },
  {
    kind: "grok",
    command: "grok",
    posixHomeRelativeDirectories: [
      [".grok", "bin"],
      [".local", "bin"],
    ],
    windowsHomeRelativeDirectories: [[".grok", "bin"]],
    windowsLocalAppDataRelativeDirectories: [],
    environmentDirectories: [{ key: "GROK_BIN_DIR" }],
    runtimeHints: [],
  },
  {
    kind: "qwen",
    command: "qwen",
    posixHomeRelativeDirectories: [[".local", "bin"]],
    windowsHomeRelativeDirectories: [],
    windowsLocalAppDataRelativeDirectories: [["qwen-code", "bin"]],
    environmentDirectories: [{ key: "QWEN_INSTALL_BIN_DIR" }, { key: "QWEN_INSTALL_ROOT", suffix: ["bin"] }],
    runtimeHints: ["node"],
  },
] as const satisfies readonly AgentCliCatalogEntry[];

const catalogKinds = new Set(HERDR_AGENT_CLI_CATALOG.map(({ kind }) => kind));
if (
  catalogKinds.size !== HERDR_STARTABLE_AGENT_KINDS.length ||
  HERDR_STARTABLE_AGENT_KINDS.some((kind) => !catalogKinds.has(kind))
) {
  throw new Error("Herdr Agent CLI catalog must exactly match the startable Agent allowlist");
}
