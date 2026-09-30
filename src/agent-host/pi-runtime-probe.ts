import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeProbeResult } from "../contract/runtime";
import { readPiRuntimeVersion } from "./runtime-version";
import { probePiToolRuntime } from "./pi-tool-runtime-probe";

/** Exercises the real lazy login import without a callback server or network request. */
export async function probePiRuntimeModules(exerciseTools = false): Promise<PiRuntimeProbeResult> {
  const credentials: CredentialStore = {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      throw new Error("Runtime probe must not write credentials");
    },
    async delete() {
      throw new Error("Runtime probe must not delete credentials");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let oauthLoaded = false;
  try {
    await runtime.login("openai", "oauth", {
      async prompt() {
        throw new Error("Runtime probe must not prompt");
      },
      notify() {
        throw new Error("Runtime probe must not start authorization");
      },
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("requires a device ID (UUID)")) throw error;
    oauthLoaded = true;
  }
  if (!oauthLoaded) throw new Error("OpenAI OAuth runtime probe did not reach the lazy login module");
  const mcp = await import("@earendil-works/pi-mcp");
  const oauth = await import("@earendil-works/pi-mcp/oauth");
  if (typeof mcp.McpClient !== "function" || typeof oauth.authorizeMcp !== "function") {
    throw new Error("MCP client or OAuth public entry is missing");
  }
  const tools = exerciseTools ? await probePiToolRuntime(runtime) : {};
  return { piVersion: readPiRuntimeVersion(), openaiOAuthLoaded: true, mcpLoaded: true, ...tools };
}
