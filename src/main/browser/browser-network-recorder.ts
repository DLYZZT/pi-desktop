import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  BrowserNetworkBodyResult,
  BrowserNetworkPage,
  BrowserNetworkRequest,
  BrowserNetworkSummary,
  BrowserNetworkSummaryRequest,
} from "../../contract/browser.ts";
import type { BrowserCdpCoordinator, BrowserCdpEvent } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { redactBrowserText, redactBrowserUrl } from "./browser-redaction.ts";

const MAX_AUTOMATIC_BODY_BYTES = 512 * 1024;
const MAX_BODY_READ_BYTES = 4 * 1024 * 1024;
const REPLAY_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_BODY_CAPTURE_IDLE_MS = 2 * 60 * 1_000;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-authenticate",
]);

export interface BrowserSealedReplayRecord {
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  createdAt: number;
}

type InternalRequest = BrowserNetworkRequest & {
  cdpRequestId?: string;
  bodyId?: string;
  bodySource?: BrowserNetworkBodyResult["source"];
};

type StoredBody = {
  filePath: string;
  size: number;
  totalSize: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  source: BrowserNetworkBodyResult["source"];
  lastAccessedAt: number;
};

export interface BrowserNetworkRecorderOptions {
  tabId: string;
  cdp: BrowserCdpCoordinator;
  bodyDirectory: string;
  maxRequests: () => number;
  maxBodyBytes: () => number;
  now?: () => number;
  bodyCaptureIdleMs?: number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}

export class BrowserNetworkRecorder {
  private readonly options: BrowserNetworkRecorderOptions;
  private readonly now: () => number;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private readonly requests = new Map<string, InternalRequest>();
  private readonly cdpToOpaque = new Map<string, string>();
  private readonly sealed = new Map<string, BrowserSealedReplayRecord>();
  private readonly bodies = new Map<string, StoredBody>();
  private readonly waiters = new Set<{
    predicate: (request: BrowserNetworkRequest) => boolean;
    resolve: (request: BrowserNetworkRequest) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sequence = 0;
  private totalBodyBytes = 0;
  private unsubscribe?: () => void;
  private releaseNetwork?: () => Promise<void>;
  private started = false;
  private bodyCaptureUntil = 0;
  private bodyCaptureEpoch = 0;
  private bodyCaptureTimer?: ReturnType<typeof setTimeout>;

  constructor(options: BrowserNetworkRecorderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalThis;
  }

  async start(): Promise<void> {
    if (this.started) return;
    fs.mkdirSync(this.options.bodyDirectory, { recursive: true, mode: 0o700 });
    this.unsubscribe = this.options.cdp.subscribe(this.options.tabId, (event) => this.handleEvent(event));
    try {
      this.releaseNetwork = await this.options.cdp.enableDomain(this.options.tabId, "Network", {
        maxResourceBufferSize: 2 * 1024 * 1024,
        maxTotalBufferSize: Math.max(32 * 1024 * 1024, this.options.maxBodyBytes() * 2),
      });
      this.started = true;
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopBodyCapture();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const release = this.releaseNetwork;
    this.releaseNetwork = undefined;
    if (release) await release();
    for (const waiter of this.waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new BrowserError("CAPABILITY_DISABLED", "Browser network capture was disabled"));
    }
    this.waiters.clear();
    this.clear();
  }

  armBodyCapture(): void {
    if (!this.started) return;
    const idleMs = Math.max(1, Math.round(this.options.bodyCaptureIdleMs ?? DEFAULT_BODY_CAPTURE_IDLE_MS));
    this.bodyCaptureUntil = this.now() + idleMs;
    if (this.bodyCaptureTimer) this.timers.clearTimeout(this.bodyCaptureTimer);
    this.bodyCaptureTimer = this.timers.setTimeout(() => this.stopBodyCapture(), idleMs);
    this.bodyCaptureTimer.unref?.();
  }

  list(input: {
    after?: string;
    resourceTypes?: string[];
    urlPattern?: string;
    status?: number;
    limit?: number;
  }): BrowserNetworkPage {
    this.pruneExpiredReplayRecords();
    const afterSequence = input.after ? this.requests.get(input.after)?.sequence : undefined;
    const resourceTypes = new Set((input.resourceTypes ?? []).map((value) => value.toLowerCase()));
    const pattern = compileUrlPattern(input.urlPattern);
    const limit = clamp(input.limit ?? 100, 1, 500);
    const matches = [...this.requests.values()]
      .filter((request) => afterSequence === undefined || request.sequence > afterSequence)
      .filter((request) => resourceTypes.size === 0 || resourceTypes.has(request.resourceType.toLowerCase()))
      .filter((request) => !pattern || pattern.test(request.url))
      .filter((request) => input.status === undefined || request.status === input.status)
      .sort((left, right) => left.sequence - right.sequence);
    const page = matches.slice(0, limit);
    return {
      requests: page.map(publicRequest),
      ...(matches.length > page.length && page.length ? { nextCursor: page[page.length - 1]!.requestId } : {}),
      truncated: matches.length > page.length,
      untrustedWebContent: true,
    };
  }

  summary(input: { failureLimit?: number; recentLimit?: number } = {}): BrowserNetworkSummary {
    const requests = [...this.requests.values()].sort((left, right) => left.sequence - right.sequence);
    const failureLimit = clamp(input.failureLimit ?? 10, 0, 20);
    const recentLimit = clamp(input.recentLimit ?? 10, 0, 20);
    const byResourceType: Record<string, number> = {};
    const byStatusClass: Record<string, number> = {};
    let completed = 0;
    let failed = 0;
    let pending = 0;
    for (const request of requests) {
      const resourceType = request.resourceType.slice(0, 64) || "Other";
      byResourceType[resourceType] = (byResourceType[resourceType] ?? 0) + 1;
      if (request.failed) {
        failed += 1;
      } else if (request.completedAt === undefined) {
        pending += 1;
      } else {
        completed += 1;
      }
      const statusClass =
        request.status !== undefined
          ? `${Math.floor(request.status / 100)}xx`
          : request.failed
            ? "failed"
            : request.completedAt === undefined
              ? "pending"
              : "unknown";
      byStatusClass[statusClass] = (byStatusClass[statusClass] ?? 0) + 1;
    }
    return {
      total: requests.length,
      completed,
      failed,
      pending,
      byResourceType,
      byStatusClass,
      failures: requests
        .filter((request) => request.failed)
        .slice(-failureLimit)
        .map(summaryRequest),
      recent: requests.slice(-recentLimit).map(summaryRequest),
      untrustedWebContent: true,
    };
  }

  wait(
    input: { urlPattern?: string; resourceType?: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<BrowserNetworkRequest> {
    const pattern = compileUrlPattern(input.urlPattern);
    const type = input.resourceType?.toLowerCase();
    const predicate = (request: BrowserNetworkRequest) =>
      (!pattern || pattern.test(request.url)) && (!type || request.resourceType.toLowerCase() === type);
    const existing = [...this.requests.values()].reverse().find(predicate);
    if (existing) return Promise.resolve(publicRequest(existing));
    const timeoutMs = clamp(input.timeoutMs ?? 30_000, 50, 120_000);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: this.timers.setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new BrowserError("ACTION_TIMEOUT", "Waiting for a Browser network request timed out"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.waiters.delete(waiter)) return;
          this.timers.clearTimeout(waiter.timer);
          reject(new BrowserError("USER_TOOK_CONTROL", "Browser network wait was cancelled"));
        },
        { once: true },
      );
    });
  }

  async body(
    requestId: string,
    input: { full?: boolean; offset?: number; maxBytes?: number },
  ): Promise<BrowserNetworkBodyResult> {
    const request = this.requireRequest(requestId);
    let stored = request.bodyId ? this.bodies.get(request.bodyId) : undefined;
    if ((!stored || input.full) && request.cdpRequestId) {
      try {
        const result = await this.options.cdp.sendCommand<{ body?: string; base64Encoded?: boolean }>(
          this.options.tabId,
          "Network.getResponseBody",
          { requestId: request.cdpRequestId },
        );
        if (typeof result.body === "string") {
          const data = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
          const bodyId = this.storeBody(request.requestId, data, request.mimeType ?? "application/octet-stream", {
            encoding: result.base64Encoded ? "base64" : "utf8",
            source: "cdp",
          });
          if (bodyId) {
            request.bodyId = bodyId;
            request.bodyAvailable = true;
            request.bodyTruncated = data.byteLength > this.options.maxBodyBytes();
            request.bodySource = "cdp";
            stored = this.bodies.get(bodyId);
          }
        }
      } catch {
        // Callers may use the same-Session refetch fallback when CDP has evicted the body.
      }
    }
    if (!stored) {
      throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser response body is no longer available", {
        retryable: request.method === "GET",
      });
    }
    return this.readStoredBody(request.requestId, stored, input.offset, input.maxBytes);
  }

  getRequest(requestId: string): BrowserNetworkRequest {
    return publicRequest(this.requireRequest(requestId));
  }

  getSealedReplayRecord(requestId: string): BrowserSealedReplayRecord {
    this.pruneExpiredReplayRecords();
    const record = this.sealed.get(requestId);
    if (!record) {
      throw new BrowserError("REQUEST_REPLAY_EXPIRED", "Browser request replay data expired or was unavailable");
    }
    return structuredClone(record);
  }

  recordRefetchedBody(requestId: string, data: Buffer, mimeType: string): BrowserNetworkBodyResult {
    const request = this.requireRequest(requestId);
    const bodyId = this.storeBody(requestId, data, mimeType, {
      encoding: isTextMime(mimeType) ? "utf8" : "base64",
      source: "session-refetch",
    });
    if (!bodyId) {
      throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser response body capture is not active");
    }
    request.bodyId = bodyId;
    request.bodyAvailable = true;
    request.bodyTruncated = data.byteLength > this.options.maxBodyBytes();
    request.bodySource = "session-refetch";
    return this.readStoredBody(requestId, this.bodies.get(bodyId)!, 0, MAX_BODY_READ_BYTES);
  }

  recordReplay(input: {
    replayedFrom: string;
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    status: number;
    statusText: string;
    responseHeaders: Record<string, string>;
    body: Buffer;
    mimeType: string;
  }): BrowserNetworkRequest {
    const requestId = randomUUID();
    const now = this.now();
    const request: InternalRequest = {
      requestId,
      sequence: ++this.sequence,
      tabId: this.options.tabId,
      method: input.method,
      url: sanitizeUrl(input.url),
      origin: safeOrigin(input.url),
      resourceType: "Replay",
      status: input.status,
      statusText: input.statusText.slice(0, 256),
      mimeType: input.mimeType.slice(0, 256),
      requestHeaders: sanitizeHeaders(input.requestHeaders),
      responseHeaders: sanitizeHeaders(input.responseHeaders),
      encodedDataLength: input.body.byteLength,
      startedAt: now,
      completedAt: now,
      bodyAvailable: false,
      bodyTruncated: input.body.byteLength > this.options.maxBodyBytes(),
      replayable: true,
      replayedFrom: input.replayedFrom,
      untrustedWebContent: true,
    };
    if (input.body.byteLength) {
      const bodyId = this.storeBody(requestId, input.body, input.mimeType, {
        encoding: isTextMime(input.mimeType) ? "utf8" : "base64",
        source: "replay",
      });
      if (bodyId) {
        request.bodyId = bodyId;
        request.bodyAvailable = true;
        request.bodySource = "replay";
      }
    }
    this.requests.set(requestId, request);
    this.notifyWaiters(request);
    this.enforceRequestCapacity();
    return publicRequest(request);
  }

  count(): number {
    return this.requests.size;
  }

  clear(): void {
    for (const body of this.bodies.values()) {
      try {
        fs.rmSync(body.filePath, { force: true });
      } catch {
        // Best effort cleanup.
      }
    }
    this.requests.clear();
    this.cdpToOpaque.clear();
    this.sealed.clear();
    this.bodies.clear();
    this.totalBodyBytes = 0;
    try {
      fs.rmSync(this.options.bodyDirectory, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }

  private handleEvent(event: BrowserCdpEvent): void {
    switch (event.method) {
      case "Network.requestWillBeSent":
        this.onRequestWillBeSent(event.params);
        break;
      case "Network.requestWillBeSentExtraInfo":
        this.onRequestExtraInfo(event.params);
        break;
      case "Network.responseReceived":
        this.onResponseReceived(event.params);
        break;
      case "Network.responseReceivedExtraInfo":
        this.onResponseExtraInfo(event.params);
        break;
      case "Network.loadingFinished":
        this.onLoadingFinished(event.params);
        break;
      case "Network.loadingFailed":
        this.onLoadingFailed(event.params);
        break;
    }
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    const cdpRequestId = asString(params.requestId, 512);
    const requestValue = asRecord(params.request);
    const url = asString(requestValue.url, 8_192);
    const method = asString(requestValue.method, 32).toUpperCase();
    if (!cdpRequestId || !url || !method) return;
    const priorId = this.cdpToOpaque.get(cdpRequestId);
    const redirect = asRecord(params.redirectResponse);
    if (priorId && Object.keys(redirect).length) {
      const prior = this.requests.get(priorId);
      if (prior) {
        prior.status = asNumber(redirect.status);
        prior.statusText = asString(redirect.statusText, 256);
        prior.responseHeaders = sanitizeHeaders(asStringRecord(redirect.headers));
        prior.completedAt = this.now();
      }
    }
    const requestId = randomUUID();
    const now = this.now();
    const requestHeaders = asStringRecord(requestValue.headers);
    const postData = asOptionalString(requestValue.postData, 8 * 1024 * 1024);
    const request: InternalRequest = {
      requestId,
      cdpRequestId,
      sequence: ++this.sequence,
      tabId: this.options.tabId,
      method,
      url: sanitizeUrl(url),
      origin: safeOrigin(url),
      resourceType: asString(params.type, 64) || "Other",
      requestHeaders: sanitizeHeaders(requestHeaders),
      startedAt: now,
      bodyAvailable: false,
      bodyTruncated: false,
      replayable: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method),
      untrustedWebContent: true,
    };
    this.requests.set(requestId, request);
    this.cdpToOpaque.set(cdpRequestId, requestId);
    if (request.replayable && this.isBodyCaptureActive()) {
      this.sealed.set(requestId, {
        requestId,
        method,
        url,
        headers: requestHeaders,
        ...(postData === undefined ? {} : { postData }),
        createdAt: now,
      });
    }
    this.notifyWaiters(request);
    this.enforceRequestCapacity();
  }

  private onRequestExtraInfo(params: Record<string, unknown>): void {
    const request = this.requestForCdp(params.requestId);
    if (!request) return;
    const headers = asStringRecord(params.headers);
    request.requestHeaders = sanitizeHeaders(headers);
    const sealed = this.sealed.get(request.requestId);
    if (sealed) sealed.headers = headers;
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const request = this.requestForCdp(params.requestId);
    if (!request) return;
    const response = asRecord(params.response);
    request.status = asNumber(response.status);
    request.statusText = asString(response.statusText, 256);
    request.mimeType = asString(response.mimeType, 256);
    request.responseHeaders = sanitizeHeaders(asStringRecord(response.headers));
    if (params.type) request.resourceType = asString(params.type, 64) || request.resourceType;
  }

  private onResponseExtraInfo(params: Record<string, unknown>): void {
    const request = this.requestForCdp(params.requestId);
    if (!request) return;
    request.responseHeaders = sanitizeHeaders(asStringRecord(params.headers));
    const status = asNumber(params.statusCode);
    if (status !== undefined) request.status = status;
  }

  private onLoadingFinished(params: Record<string, unknown>): void {
    const request = this.requestForCdp(params.requestId);
    if (!request) return;
    request.completedAt = this.now();
    request.encodedDataLength = asNumber(params.encodedDataLength);
    if (
      request.cdpRequestId &&
      this.isBodyCaptureActive() &&
      isTextMime(request.mimeType ?? "") &&
      (request.encodedDataLength ?? 0) <= MAX_AUTOMATIC_BODY_BYTES
    ) {
      void this.captureAutomaticBody(request);
    }
  }

  private onLoadingFailed(params: Record<string, unknown>): void {
    const request = this.requestForCdp(params.requestId);
    if (!request) return;
    request.completedAt = this.now();
    request.failed = asString(params.errorText, 512) || "Request failed";
  }

  private async captureAutomaticBody(request: InternalRequest): Promise<void> {
    if (!request.cdpRequestId || !this.requests.has(request.requestId) || !this.isBodyCaptureActive()) return;
    const captureEpoch = this.bodyCaptureEpoch;
    try {
      const result = await this.options.cdp.sendCommand<{ body?: string; base64Encoded?: boolean }>(
        this.options.tabId,
        "Network.getResponseBody",
        { requestId: request.cdpRequestId },
      );
      if (typeof result.body !== "string" || captureEpoch !== this.bodyCaptureEpoch || !this.isBodyCaptureActive()) {
        return;
      }
      const data = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
      const bodyId = this.storeBody(
        request.requestId,
        data,
        request.mimeType ?? "text/plain",
        {
          encoding: result.base64Encoded ? "base64" : "utf8",
          source: "captured",
        },
        MAX_AUTOMATIC_BODY_BYTES,
      );
      if (!bodyId) return;
      request.bodyId = bodyId;
      request.bodyAvailable = true;
      request.bodyTruncated = data.byteLength > MAX_AUTOMATIC_BODY_BYTES;
      request.bodySource = "captured";
    } catch {
      // The explicit body tool can retry through CDP or the Session GET fallback.
    }
  }

  private storeBody(
    requestId: string,
    input: Buffer,
    mimeType: string,
    metadata: Pick<StoredBody, "encoding" | "source">,
    maxStoredBytes = this.options.maxBodyBytes(),
  ): string | undefined {
    if (!this.isBodyCaptureActive()) return undefined;
    const limit = Math.min(this.options.maxBodyBytes(), maxStoredBytes);
    const data = input.subarray(0, Math.min(input.byteLength, limit));
    const prior = this.bodies.get(requestId);
    if (prior) {
      this.totalBodyBytes -= prior.size;
      try {
        fs.rmSync(prior.filePath, { force: true });
      } catch {
        // Continue replacing an inaccessible stale body.
      }
    }
    fs.mkdirSync(this.options.bodyDirectory, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.options.bodyDirectory, `${requestId}.body`);
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    const stored: StoredBody = {
      filePath,
      size: data.byteLength,
      totalSize: input.byteLength,
      mimeType: mimeType.slice(0, 256) || "application/octet-stream",
      encoding: metadata.encoding,
      source: metadata.source,
      lastAccessedAt: this.now(),
    };
    this.bodies.set(requestId, stored);
    this.totalBodyBytes += stored.size;
    this.enforceBodyCapacity();
    return requestId;
  }

  private isBodyCaptureActive(): boolean {
    return this.started && this.bodyCaptureUntil > this.now();
  }

  private stopBodyCapture(): void {
    if (this.bodyCaptureTimer) this.timers.clearTimeout(this.bodyCaptureTimer);
    this.bodyCaptureTimer = undefined;
    this.bodyCaptureUntil = 0;
    this.bodyCaptureEpoch += 1;
    this.clearCapturedPayloads();
  }

  private clearCapturedPayloads(): void {
    for (const body of this.bodies.values()) {
      try {
        fs.rmSync(body.filePath, { force: true });
      } catch {
        // Best effort cleanup.
      }
    }
    this.bodies.clear();
    this.totalBodyBytes = 0;
    this.sealed.clear();
    for (const request of this.requests.values()) {
      request.bodyId = undefined;
      request.bodySource = undefined;
      request.bodyAvailable = false;
    }
    try {
      fs.rmSync(this.options.bodyDirectory, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }

  private readStoredBody(
    requestId: string,
    stored: StoredBody,
    offsetValue?: number,
    maxBytesValue?: number,
  ): BrowserNetworkBodyResult {
    const offset = clamp(offsetValue ?? 0, 0, stored.size);
    const maxBytes = clamp(maxBytesValue ?? MAX_AUTOMATIC_BODY_BYTES, 1, MAX_BODY_READ_BYTES);
    const data = fs.readFileSync(stored.filePath).subarray(offset, offset + maxBytes);
    stored.lastAccessedAt = this.now();
    return {
      requestId,
      mimeType: stored.mimeType,
      encoding: stored.encoding,
      data: stored.encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
      offset,
      returnedBytes: data.byteLength,
      totalBytes: stored.totalSize,
      truncated: offset + data.byteLength < stored.totalSize,
      source: stored.source,
      untrustedWebContent: true,
    };
  }

  private requireRequest(requestId: string): InternalRequest {
    if (typeof requestId !== "string") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser network request id is invalid");
    }
    const request = this.requests.get(requestId);
    if (!request) throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser network request was not found");
    return request;
  }

  private requestForCdp(value: unknown): InternalRequest | undefined {
    const cdpId = asString(value, 512);
    const requestId = this.cdpToOpaque.get(cdpId);
    return requestId ? this.requests.get(requestId) : undefined;
  }

  private notifyWaiters(request: InternalRequest): void {
    const publicValue = publicRequest(request);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(publicValue)) continue;
      this.waiters.delete(waiter);
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(publicValue);
    }
  }

  private enforceRequestCapacity(): void {
    const limit = clamp(this.options.maxRequests(), 50, 5_000);
    while (this.requests.size > limit) {
      const oldest = this.requests.values().next().value as InternalRequest | undefined;
      if (!oldest) break;
      this.deleteRequest(oldest.requestId);
    }
  }

  private enforceBodyCapacity(): void {
    const limit = this.options.maxBodyBytes();
    while (this.totalBodyBytes > limit && this.bodies.size) {
      const oldest = [...this.bodies.entries()].sort(
        (left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
      )[0];
      if (!oldest) break;
      const [requestId, body] = oldest;
      this.bodies.delete(requestId);
      this.totalBodyBytes -= body.size;
      const request = this.requests.get(requestId);
      if (request) {
        request.bodyId = undefined;
        request.bodyAvailable = false;
      }
      try {
        fs.rmSync(body.filePath, { force: true });
      } catch {
        // Best effort LRU cleanup.
      }
    }
  }

  private deleteRequest(requestId: string): void {
    const request = this.requests.get(requestId);
    this.requests.delete(requestId);
    this.sealed.delete(requestId);
    if (request?.cdpRequestId && this.cdpToOpaque.get(request.cdpRequestId) === requestId) {
      this.cdpToOpaque.delete(request.cdpRequestId);
    }
    const body = this.bodies.get(requestId);
    if (!body) return;
    this.bodies.delete(requestId);
    this.totalBodyBytes -= body.size;
    try {
      fs.rmSync(body.filePath, { force: true });
    } catch {
      // Best effort eviction.
    }
  }

  private pruneExpiredReplayRecords(): void {
    const cutoff = this.now() - REPLAY_TTL_MS;
    for (const [requestId, record] of this.sealed) {
      if (record.createdAt < cutoff) this.sealed.delete(requestId);
    }
  }
}

function publicRequest(request: InternalRequest): BrowserNetworkRequest {
  const { cdpRequestId: _cdpRequestId, bodyId: _bodyId, bodySource: _bodySource, ...value } = request;
  return structuredClone(value);
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || SENSITIVE_HEADERS.has(normalized) || normalized === "x-api-key") continue;
    result[name.slice(0, 256)] = value.slice(0, 8_192);
  }
  return result;
}

function sanitizeUrl(value: string): string {
  return redactBrowserUrl(value);
}

function summaryRequest(request: InternalRequest): BrowserNetworkSummaryRequest {
  return {
    requestId: request.requestId,
    method: request.method,
    url: request.url,
    resourceType: request.resourceType,
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.failed ? { failed: redactBrowserText(request.failed, 512) } : {}),
  };
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "opaque";
  } catch {
    return "opaque";
  }
}

function isTextMime(value: string): boolean {
  return /^(?:text\/|application\/(?:json|.+\+json|xml|.+\+xml|javascript|x-javascript|yaml|x-yaml|csv))/i.test(value);
}

function compileUrlPattern(value?: string): RegExp | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 2_048 || /[\0\r\n]/.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser network URL pattern is invalid");
  }
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(escaped, "i");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function asOptionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") result[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") result[key] = String(entry);
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
