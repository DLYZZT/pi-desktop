import type { ApiHandler } from "../../contract/rpc";
import type { HerdrSettings } from "../../contract/herdr";
import { HerdrBridgeError } from "../herdr/errors";
import type { initializeHerdrBridge } from "../herdr/runtime";
import { assertPathAllowed } from "../path-authorization";

export function assertHerdrParamKeys(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === undefined && allowedKeys.length === 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Herdr request parameters are invalid.");
  }
  const params = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(params).some((key) => !allowed.has(key))) {
    throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Herdr request contains an unsupported parameter.");
  }
  return params;
}

type HerdrHandlers = {
  runtimeGet: NonNullable<ApiHandler["herdr.runtime.get"]>;
  runtimeConfigure: NonNullable<ApiHandler["herdr.runtime.configure"]>;
  runtimeProbe: NonNullable<ApiHandler["herdr.runtime.probe"]>;
  runtimeRestart: NonNullable<ApiHandler["herdr.runtime.restart"]>;
  runtimeConnect: NonNullable<ApiHandler["herdr.runtime.connect"]>;
  runtimeDisconnect: NonNullable<ApiHandler["herdr.runtime.disconnect"]>;
  diagnostics: NonNullable<ApiHandler["herdr.diagnostics"]>;
  snapshot: NonNullable<ApiHandler["herdr.snapshot"]>;
  workspaceCreate: NonNullable<ApiHandler["herdr.workspace.create"]>;
  paneSplit: NonNullable<ApiHandler["herdr.pane.split"]>;
  paneRead: NonNullable<ApiHandler["herdr.pane.read"]>;
  agentStart: NonNullable<ApiHandler["herdr.agent.start"]>;
  agentPrompt: NonNullable<ApiHandler["herdr.agent.prompt"]>;
  agentSendKeys: NonNullable<ApiHandler["herdr.agent.sendKeys"]>;
  agentWait: NonNullable<ApiHandler["herdr.agent.wait"]>;
  agentWaitCancel: NonNullable<ApiHandler["herdr.agent.waitCancel"]>;
  terminalOpen: NonNullable<ApiHandler["herdr.terminal.open"]>;
  terminalInput: NonNullable<ApiHandler["herdr.terminal.input"]>;
  terminalResize: NonNullable<ApiHandler["herdr.terminal.resize"]>;
  terminalAck: NonNullable<ApiHandler["herdr.terminal.ack"]>;
  terminalClose: NonNullable<ApiHandler["herdr.terminal.close"]>;
};
export function createHerdrHandlers(
  herdr: Pick<
    ReturnType<typeof initializeHerdrBridge>,
    | "getRuntime"
    | "configure"
    | "probe"
    | "restartManagedServer"
    | "connect"
    | "disconnect"
    | "getDiagnostics"
    | "refreshSnapshot"
    | "createWorkspace"
    | "splitPane"
    | "readPane"
    | "startAgent"
    | "promptAgent"
    | "sendAgentKeys"
    | "waitAgent"
    | "cancelWait"
    | "openTerminal"
    | "getTerminals"
  >,
  herdrCall: <T>(operation: () => T | Promise<T>) => Promise<T>,
) {
  return {
    runtimeGet: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.getRuntime();
      }),

    runtimeConfigure: (params) =>
      herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["settings"]) as { settings: HerdrSettings };
        return herdr.configure(body.settings);
      }),

    runtimeProbe: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.probe();
      }),

    runtimeRestart: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.restartManagedServer();
      }),

    runtimeConnect: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.connect();
      }),

    runtimeDisconnect: (params) =>
      herdrCall(async () => {
        assertHerdrParamKeys(params, []);
        await herdr.disconnect(false);
        return { ok: true as const };
      }),

    diagnostics: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.getDiagnostics();
      }),

    snapshot: (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.refreshSnapshot();
      }),

    workspaceCreate: async (params) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["cwd", "name"]) as { cwd: string; name?: string };
        if (
          typeof body.cwd !== "string" ||
          !body.cwd ||
          body.cwd.length > 4_096 ||
          /[\0\r\n]/.test(body.cwd) ||
          (body.name !== undefined &&
            (typeof body.name !== "string" ||
              !body.name.trim() ||
              body.name.length > 256 ||
              /[\0\r\n]/.test(body.name)))
        ) {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace parameters are invalid.");
        }
        await assertPathAllowed(body.cwd);
        return herdr.createWorkspace(body.cwd, body.name);
      });
    },

    paneSplit: async (params) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["paneId", "direction", "cwd"]) as {
          paneId?: string;
          direction?: "horizontal" | "vertical";
          cwd?: string;
        };
        if (body.cwd !== undefined) {
          if (typeof body.cwd !== "string" || !body.cwd || body.cwd.length > 4_096 || /[\0\r\n]/.test(body.cwd)) {
            throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane split parameters are invalid.");
          }
          await assertPathAllowed(body.cwd);
        }
        return herdr.splitPane(body.paneId!, body.direction!, body.cwd);
      });
    },

    paneRead: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "maxBytes"]) as {
          paneId?: string;
          maxBytes?: number;
        };
        return herdr.readPane(body.paneId!, body.maxBytes);
      });
    },

    agentStart: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "kind"]);
        return herdr.startAgent(body.paneId as string, body.kind);
      });
    },

    agentPrompt: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "prompt"]);
        return herdr.promptAgent(body.paneId as string, body.prompt);
      });
    },

    agentSendKeys: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "keys"]);
        return herdr.sendAgentKeys(body.paneId as string, body.keys);
      });
    },

    agentWait: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "states", "timeoutMs", "requestId"]);
        return herdr.waitAgent(body.paneId as string, body.states, body.timeoutMs, body.requestId);
      });
    },

    agentWaitCancel: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["requestId"]);
        herdr.cancelWait(body.requestId);
        return { ok: true as const };
      });
    },

    terminalOpen: (params, context) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["paneId", "mode", "cols", "rows", "takeover"]) as {
          paneId?: string;
          mode?: "observe" | "control";
          cols?: number;
          rows?: number;
          takeover?: boolean;
        };
        if (body.takeover !== undefined && typeof body.takeover !== "boolean") {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal takeover must be a boolean.");
        }
        const result = await herdr.openTerminal(body.paneId!, body.mode!, body.cols!, body.rows!, body.takeover);
        context?.setLease(`herdr.terminal:${result.terminalId}`, () => {
          herdr.getTerminals().scheduleOrphanRelease(result.terminalId);
        });
        return result;
      });
    },

    terminalInput: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "bytes"]) as {
          terminalId?: string;
          bytes?: Uint8Array;
        };
        herdr.getTerminals().get(body.terminalId!).input(body.bytes!);
        return { accepted: true as const };
      });
    },

    terminalResize: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "cols", "rows"]) as {
          terminalId?: string;
          cols?: number;
          rows?: number;
        };
        herdr.getTerminals().get(body.terminalId!).resize(body.cols!, body.rows!);
        return { accepted: true as const };
      });
    },

    terminalAck: (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "seq"]) as {
          terminalId?: string;
          seq?: number;
        };
        herdr.getTerminals().get(body.terminalId!).ack(body.seq!);
        return { ok: true as const };
      });
    },

    terminalClose: (params, context) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["terminalId", "release"]) as {
          terminalId?: string;
          release?: boolean;
        };
        if (typeof body.release !== "boolean") {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal release must be a boolean.");
        }
        context?.releaseLease(`herdr.terminal:${body.terminalId!}`);
        await herdr.getTerminals().close(body.terminalId!, body.release === true);
        return { ok: true as const };
      });
    },
  } satisfies HerdrHandlers;
}
