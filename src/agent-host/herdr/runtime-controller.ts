import type { HerdrRuntimeDescriptor } from "../../contract/herdr";
import { HerdrBridgeError } from "./errors";

type Listener = (descriptor: HerdrRuntimeDescriptor) => void | Promise<void>;

export class HerdrRuntimeController {
  private descriptor: HerdrRuntimeDescriptor = {
    revision: 0,
    enabled: false,
    mode: "attach",
    sessionName: "default",
    autoConnect: true,
    releaseControlOnViewClose: true,
  };
  private listeners = new Set<Listener>();
  private hostGeneration = 0;

  get(): HerdrRuntimeDescriptor {
    return structuredClone(this.descriptor);
  }

  apply(value: HerdrRuntimeDescriptor): void {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new HerdrBridgeError("HERDR_INVALID_ARGUMENT", "The Herdr runtime descriptor revision is invalid.");
    }
    if (value.hostGeneration !== undefined) {
      if (!Number.isSafeInteger(value.hostGeneration) || value.hostGeneration < 1) {
        throw new HerdrBridgeError("HERDR_INVALID_ARGUMENT", "The Herdr Host generation is invalid.");
      }
      if (this.hostGeneration !== 0 && value.hostGeneration !== this.hostGeneration) {
        throw new HerdrBridgeError(
          "HERDR_REQUEST_CANCELLED",
          "The Herdr runtime descriptor belongs to another Host generation.",
        );
      }
      this.hostGeneration = value.hostGeneration;
    }
    if (value.revision < this.descriptor.revision) {
      throw new HerdrBridgeError("HERDR_REQUEST_CANCELLED", "The Herdr runtime descriptor is stale.");
    }
    if (value.revision === this.descriptor.revision) return;
    if (value.enabled && (!value.executable || !value.endpoint) && !value.error && value.probing !== true) {
      throw new HerdrBridgeError("HERDR_INVALID_ARGUMENT", "The enabled Herdr runtime descriptor is incomplete.");
    }
    this.descriptor = structuredClone(value);
    for (const listener of this.listeners) void listener(this.get());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const herdrRuntimeController = new HerdrRuntimeController();
