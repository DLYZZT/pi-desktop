import type { ChildProcess } from "node:child_process";
import type {
  ManagedProcessExit,
  ManagedProcessReaperRecord,
  ManagedProcessStopMode,
  ManagedProcessStopSource,
} from "../../contract/processes.ts";
import type { CommandDescriptor, ToolExecutionContext } from "../../shared/toolchains/types.ts";
import type { ManagedProcessOwnerRuntimeIdentity } from "./owner-identity.ts";

export type ManagedProcessBackendEvent =
  | { type: "stdout" | "stderr"; bytes: Buffer }
  | { type: "output-dropped"; bytes: number; chunks: number }
  | { type: "stdin-closed" }
  | { type: "stopping"; phase: "interrupt" | "terminate" | "force" }
  | { type: "exit"; exit: Omit<ManagedProcessExit, "finishedAt"> }
  | { type: "error"; subcode: string; message?: string };

export interface PreparedManagedProcessLaunch {
  processId: string;
  runId: string;
  cwd: string;
  command: string;
  shell: Pick<CommandDescriptor, "executable" | "argvPrefix" | "cwdSemantics">;
  context: ToolExecutionContext;
  owner?: ManagedProcessOwnerRuntimeIdentity;
}

export interface PreparedContainment {
  reaper: ManagedProcessReaperRecord;
  privateState: unknown;
}

export interface StartedContainment {
  started: true;
}

export interface ManagedProcessBackend {
  readonly child?: ChildProcess;
  onEvent(listener: (event: ManagedProcessBackendEvent) => void): () => void;
  prepare(input: PreparedManagedProcessLaunch, signal?: AbortSignal): Promise<PreparedContainment>;
  commit(prepared: PreparedContainment, journalRevision: number): Promise<StartedContainment>;
  write(input: { text: string; appendNewline: boolean; close: boolean }): void;
  stop(mode: ManagedProcessStopMode, source: ManagedProcessStopSource): Promise<void>;
  waitForExit(): Promise<void>;
  dispose(): Promise<void>;
}
