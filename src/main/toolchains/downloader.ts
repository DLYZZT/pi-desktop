import { createHash } from "node:crypto";
import fs from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { isCatalogArtifactUrlAllowed, type RuntimeCatalogVariant } from "../../shared/toolchains/catalog-schema.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import type { ManagedComponentId } from "../../shared/toolchains/types.ts";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const MAX_RUNTIME_REDIRECTS = 5;
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "nodejs.org",
  "releases.astral.sh",
]);

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export interface RuntimeDownloaderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export function assertRuntimeRedirectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolchainError({ code: "TOOLCHAIN_DOWNLOAD_REJECTED", message: "Artifact redirect is invalid" });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !REDIRECT_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new ToolchainError({ code: "TOOLCHAIN_DOWNLOAD_REJECTED", message: "Artifact redirect was rejected" });
  }
  return url;
}

async function fetchArtifact(
  componentId: ManagedComponentId,
  initialUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  if (!isCatalogArtifactUrlAllowed(componentId, initialUrl)) {
    throw new ToolchainError({
      code: "TOOLCHAIN_DOWNLOAD_REJECTED",
      message: "Artifact URL is outside the catalog allowlist",
    });
  }
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_RUNTIME_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "Pi-Agent-Desktop-Toolchain-Installer",
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new ToolchainError({
        code:
          code === "ENOTFOUND" || code === "ECONNREFUSED"
            ? "TOOLCHAIN_DOWNLOAD_OFFLINE"
            : "TOOLCHAIN_DOWNLOAD_REJECTED",
        message: "Could not download the managed runtime artifact",
        cause: error,
        causeCode: typeof code === "string" ? code : undefined,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_RUNTIME_REDIRECTS) {
        throw new ToolchainError({ code: "TOOLCHAIN_DOWNLOAD_REJECTED", message: "Artifact redirect limit exceeded" });
      }
      current = assertRuntimeRedirectUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new ToolchainError({
        code: response.status >= 500 ? "TOOLCHAIN_DOWNLOAD_OFFLINE" : "TOOLCHAIN_DOWNLOAD_REJECTED",
        message: `Managed runtime download failed with HTTP ${response.status}`,
      });
    }
    return response;
  }
  throw new ToolchainError({ code: "TOOLCHAIN_DOWNLOAD_REJECTED", message: "Artifact redirect limit exceeded" });
}

export async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function verifyDownloadedArtifact(filePath: string, variant: RuntimeCatalogVariant): Promise<boolean> {
  try {
    const result = await hashFile(filePath);
    return result.bytes === variant.downloadBytes && result.sha256 === variant.sha256;
  } catch {
    return false;
  }
}

export async function downloadRuntimeArtifact(
  componentId: ManagedComponentId,
  variant: RuntimeCatalogVariant,
  destination: string,
  options: RuntimeDownloaderOptions = {},
): Promise<void> {
  if (options.signal?.aborted) {
    throw new ToolchainError({ code: "TOOLCHAIN_CANCELLED", message: "Managed runtime download was cancelled" });
  }
  const existingArtifactIsValid = await verifyDownloadedArtifact(destination, variant);
  if (options.signal?.aborted) {
    throw new ToolchainError({ code: "TOOLCHAIN_CANCELLED", message: "Managed runtime download was cancelled" });
  }
  if (existingArtifactIsValid) {
    options.onProgress?.({ downloadedBytes: variant.downloadBytes, totalBytes: variant.downloadBytes });
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(destination);
  } catch {
    // Missing or stale files are replaced below.
  }
  const controller = new AbortController();
  let externallyAborted = false;
  const abortFromCaller = (): void => {
    externallyAborted = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchArtifact(componentId, variant.url, options.fetchImpl ?? fetch, controller.signal);
    const headerLength = response.headers.get("content-length");
    if (headerLength && Number(headerLength) !== variant.downloadBytes) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INTEGRITY_FAILED",
        message: "Artifact size does not match the catalog",
      });
    }
    const hash = createHash("sha256");
    const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    let downloadedBytes = 0;
    try {
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(value);
        downloadedBytes += chunk.length;
        if (downloadedBytes > variant.downloadBytes) {
          throw new ToolchainError({
            code: "TOOLCHAIN_INTEGRITY_FAILED",
            message: "Artifact exceeds its catalog size",
          });
        }
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, "drain");
        options.onProgress?.({ downloadedBytes, totalBytes: variant.downloadBytes });
      }
      output.end();
      await once(output, "close");
    } catch (error) {
      output.destroy();
      throw error;
    }
    if (downloadedBytes !== variant.downloadBytes || hash.digest("hex") !== variant.sha256) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INTEGRITY_FAILED",
        message: "Artifact checksum does not match the catalog",
      });
    }
  } catch (error) {
    try {
      fs.unlinkSync(destination);
    } catch {
      // Best-effort partial cleanup.
    }
    if (externallyAborted || options.signal?.aborted) {
      throw new ToolchainError({
        code: "TOOLCHAIN_CANCELLED",
        message: "Managed runtime download was cancelled",
        cause: error,
      });
    }
    if (error instanceof ToolchainError) throw error;
    throw new ToolchainError({
      code: "TOOLCHAIN_DOWNLOAD_REJECTED",
      message: "Managed runtime download failed",
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
