import type { RpcServer } from "../../contract/rpc.ts";
import { ManagedProcessService } from "./service.ts";

let service: ManagedProcessService | null = null;

export function initializeManagedProcessService(server: Pick<RpcServer, "emit">): ManagedProcessService {
  service ??= new ManagedProcessService(server);
  return service;
}

export function getManagedProcessService(): ManagedProcessService {
  if (!service) throw new Error("Managed process service is not initialized");
  return service;
}

export function peekManagedProcessService(): ManagedProcessService | null {
  return service;
}
