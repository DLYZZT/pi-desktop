export type McpScope = "global" | "project";
export type McpExposure = "direct" | "deferred" | "codemode" | "codemode-deferred" | "hidden";
export type McpConnectionState =
  "disabled" | "not-started" | "connecting" | "connected" | "needs-auth" | "disconnected" | "failed";
export interface McpServerConfig {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    callbackPort?: number;
    callbackUrl?: string;
    scope?: string;
    clientName?: string;
    clientRegistration?: "dcr" | "cimd";
    authServerMetadataUrl?: string;
    [key: string]: unknown;
  };
  auth?: { provider: string };
  description?: string;
  enabled?: boolean;
  timeout?: number;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  [key: string]: unknown;
}
export interface McpConfigEntry {
  name: string;
  scope: McpScope | "extension";
  source: string;
  config: McpServerConfig;
  overridden?: boolean;
  secretFields: string[];
  revision?: string;
}
export interface McpConfigurationSnapshot {
  scope: McpScope;
  cwd?: string;
  revision: string;
  entries: McpConfigEntry[];
  autoEnableCodemode?: boolean;
  error?: string;
}
export interface McpInstanceSnapshot {
  name: string;
  sessionId: string;
  cwd: string;
  source: string;
  scope: McpScope | "extension";
  generation: number;
  revision: string;
  state: McpConnectionState;
  observedAt: number;
  toolCount: number;
  pendingApply?: boolean;
  error?: string;
  disabledReason?: string;
  diagnostics?: string[];
}
export interface McpToolView {
  name: string;
  server: string;
  originalName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  exposure: McpExposure;
  active: boolean;
  callable: boolean;
  executionAllowed: boolean;
}
export interface McpResourceView {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  uriTemplate?: string;
}
export interface McpResourcePage {
  resources: McpResourceView[];
  templates: McpResourceView[];
  nextCursor?: string;
  nextTemplateCursor?: string;
}
export interface McpOAuthSnapshot {
  requestId: string;
  name: string;
  sessionId: string;
  state: "waiting" | "succeeded" | "cancelled" | "failed";
  authUrl?: string;
  error?: string;
}
export interface McpPanelSnapshot {
  instances: McpInstanceSnapshot[];
  tools: McpToolView[];
  adapterActive: boolean;
  inactiveReason?: "disabled" | "replaced" | "unavailable";
  projectTrusted?: boolean;
  error?: string;
  entryTools?: string[];
  emptyTools?: boolean;
  declaredEntries?: string[];
  extensions?: McpConfigEntry[];
}
export interface McpTarget {
  name: string;
  sessionId?: string;
  scope?: McpScope;
  cwd?: string;
}
