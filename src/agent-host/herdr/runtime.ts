import type { RpcServer } from "../../contract/rpc.ts";
import { HerdrBridge } from "./bridge.ts";

let bridge: HerdrBridge | null = null;

export function initializeHerdrBridge(
  server: RpcServer,
  options: { assertAllowedPath?: (target: string) => Promise<void> } = {},
): HerdrBridge {
  if (!bridge) bridge = new HerdrBridge(server, options);
  return bridge;
}

export function peekHerdrBridge(): HerdrBridge | null {
  return bridge;
}

export function clearHerdrBridge(instance: HerdrBridge): void {
  if (bridge === instance) bridge = null;
}
