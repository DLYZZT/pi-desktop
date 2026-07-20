import type { PluginsResponse, PluginScope } from "../shared/api-types";
import type { ToolchainErrorCode } from "../shared/toolchains/types";

export type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

export interface PluginActionBody {
  action: PluginAction;
  source?: string;
  scope?: PluginScope;
  cwd: string;
}

export interface PluginWorkerRequest {
  body: PluginActionBody;
  npmCommand?: string[];
}

export type PluginWorkerResponse =
  { ok: true; result: PluginsResponse } | { ok: false; error: { code: ToolchainErrorCode; message: string } };

export const PLUGIN_WORKER_RESULT_MARKER = "PI_DESKTOP_PLUGIN_WORKER_RESULT:";
