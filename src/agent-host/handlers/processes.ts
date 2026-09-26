import type { ApiHandler } from "../../contract/rpc";
import type {
  ManagedProcessReadParams,
  ManagedProcessWaitParams,
  ManagedProcessWriteParams,
} from "../../contract/processes";
import type { ManagedProcessService } from "../managed-process/service";

type ProcessHandlers = {
  list: NonNullable<ApiHandler["processes.list"]>;
  get: NonNullable<ApiHandler["processes.get"]>;
  read: NonNullable<ApiHandler["processes.read"]>;
  wait: NonNullable<ApiHandler["processes.wait"]>;
  write: NonNullable<ApiHandler["processes.write"]>;
  stop: NonNullable<ApiHandler["processes.stop"]>;
  stopAll: NonNullable<ApiHandler["processes.stopAll"]>;
  restart: NonNullable<ApiHandler["processes.restart"]>;
  dismiss: NonNullable<ApiHandler["processes.dismiss"]>;
  export: NonNullable<ApiHandler["processes.export"]>;
};
export function createProcessHandlers(
  managedProcesses: Pick<
    ManagedProcessService,
    "list" | "get" | "read" | "wait" | "write" | "stop" | "stopAll" | "restart" | "dismiss" | "exportLogs"
  >,
  managedCall: <T>(operation: () => T | Promise<T>) => Promise<T>,
) {
  return {
    list: (params) =>
      managedCall(() =>
        managedProcesses.list((params as { includeExited?: boolean } | undefined)?.includeExited === true),
      ),

    get: (params) => managedCall(() => managedProcesses.get((params as { processId: string }).processId)),

    read: (params) => managedCall(() => managedProcesses.read(params as ManagedProcessReadParams, undefined, true)),

    wait: (params) => managedCall(() => managedProcesses.wait(params as ManagedProcessWaitParams, undefined, true)),

    write: (params) => managedCall(() => managedProcesses.write(params as ManagedProcessWriteParams)),

    stop: (params) => {
      const body = params as { processId: string; runId: string; mode?: "graceful" | "force" };
      return managedCall(() => managedProcesses.stop(body.processId, body.runId, body.mode, "user"));
    },

    stopAll: (params) =>
      managedCall(async () => ({
        ok: true as const,
        stopped: await managedProcesses.stopAll(
          "user",
          (params as { mode?: "graceful" | "force" } | undefined)?.mode,
          false,
        ),
      })),

    restart: (params) => {
      const body = params as { processId: string; runId: string };
      return managedCall(() => managedProcesses.restart(body.processId, body.runId, "user"));
    },

    dismiss: (params) => managedCall(() => managedProcesses.dismiss((params as { processId: string }).processId)),

    export: (params) => {
      const body = params as {
        processId: string;
        runId: string;
        streams?: Array<"stdout" | "stderr" | "system">;
      };
      return managedCall(() => managedProcesses.exportLogs(body.processId, body.runId, body.streams));
    },
  } satisfies ProcessHandlers;
}
