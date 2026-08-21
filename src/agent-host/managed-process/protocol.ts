import type { CommandDescriptor } from "../../shared/toolchains/types.ts";
import type { ManagedProcessStopMode } from "../../contract/processes.ts";

export interface ManagedProcessWorkerBootstrap {
  type: "bootstrap";
  processId: string;
  runId: string;
  cwd: string;
  command: string;
  shell: Pick<CommandDescriptor, "executable" | "argvPrefix" | "cwdSemantics">;
}

export type ManagedProcessWorkerRequest =
  | ManagedProcessWorkerBootstrap
  | { type: "stdin"; text: string; appendNewline: boolean; close: boolean }
  | { type: "stop"; mode: ManagedProcessStopMode; source: "agent" | "user" | "host" | "main" };

export type ManagedProcessWorkerEvent =
  | { type: "started"; shellPid: number }
  | { type: "stdin-closed" }
  | { type: "stopping"; phase: "interrupt" | "terminate" | "force" }
  | { type: "exit"; code: number | null; signal?: string }
  | { type: "error"; code: string; message: string };
