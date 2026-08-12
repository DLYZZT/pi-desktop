export type PreloadTransferredPort = {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
};

export function selectTransferredHostPort(ports: readonly unknown[]): PreloadTransferredPort | undefined {
  if (ports.length !== 1) return undefined;
  const port = ports[0];
  if (!port || typeof port !== "object") return undefined;
  const candidate = port as Partial<PreloadTransferredPort>;
  if (
    typeof candidate.postMessage !== "function" ||
    typeof candidate.start !== "function" ||
    typeof candidate.close !== "function"
  ) {
    return undefined;
  }
  return candidate as PreloadTransferredPort;
}

export function isValidDeepLinkSessionMessage(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}
