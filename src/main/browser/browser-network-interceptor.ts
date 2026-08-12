import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import type {
  BrowserAdvancedRuntimePolicy,
  BrowserEvent,
  BrowserHeaderRule,
  BrowserIdentityProfile,
  BrowserNavigationSettings,
  BrowserPermissionDecision,
  BrowserPermissionRequest,
} from "../../contract/browser.ts";
import { BrowserNetworkPolicy, createSessionNetworkPolicyOptions } from "./browser-network-policy.ts";
import { applyHeaderRules, validateHeaderRules } from "./browser-header-rules.ts";
import { BrowserError } from "./browser-error.ts";
import { BrowserPermissionGrantStore } from "./browser-permission-grants.ts";

const PERMISSION_TIMEOUT_MS = 30_000;

type PermissionCallback = (allowed: boolean) => void;

type PendingPermission = {
  request: BrowserPermissionRequest;
  callback: PermissionCallback;
  timer: ReturnType<typeof setTimeout>;
  key: string;
};

export interface BrowserNetworkInterceptorOptions {
  session: Session;
  profileId: string;
  getNavigationSettings: () => BrowserNavigationSettings;
  getAdvancedRuntimePolicy: () => BrowserAdvancedRuntimePolicy;
  getTabForWebContents: (webContentsId: number) => { tabId: string; visible: boolean } | undefined;
  getIdentityForWebContents: (webContentsId: number) => BrowserIdentityProfile | undefined;
  resolveSecret: (ref: string) => string | undefined;
  emit: (event: BrowserEvent) => void;
  onBlockedRequest?: (url: string, code: string) => void;
}

export class BrowserNetworkInterceptor {
  private readonly options: BrowserNetworkInterceptorOptions;
  private readonly policy: BrowserNetworkPolicy;
  private requestRules: BrowserHeaderRule[] = [];
  private responseRules: BrowserHeaderRule[] = [];
  private readonly permissionGrants = new BrowserPermissionGrantStore();
  private readonly locallyApprovedPrivateOrigins = new Set<string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private disposed = false;

  constructor(options: BrowserNetworkInterceptorOptions) {
    this.options = options;
    this.policy = new BrowserNetworkPolicy(
      createSessionNetworkPolicyOptions(options.session, { strictNetworkAvailable: false }),
    );
    this.install();
  }

  setRequestRules(rules: unknown): void {
    this.requestRules = validateHeaderRules(this.options.profileId, rules, "request");
  }

  setResponseRules(rules: unknown): void {
    const advanced = this.options.getAdvancedRuntimePolicy();
    this.responseRules = validateHeaderRules(
      this.options.profileId,
      rules,
      "response",
      advanced.enabled && advanced.removeSiteSecurityHeaders,
    );
  }

  respondPermission(requestId: string, decision: BrowserPermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser permission request is no longer active");
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    if (decision === "allow-session") this.permissionGrants.allowSession(pending.key);
    else if (decision === "allow-once") this.permissionGrants.allowOnce(pending.key);
    pending.callback(decision !== "deny");
    this.options.emit({ type: "permission-resolved", requestId });
  }

  listPermissionRequests(): BrowserPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((entry) => structuredClone(entry.request));
  }

  approvePrivateOrigin(origin: string): void {
    const normalized = safeOrigin(origin);
    if (!normalized) throw new BrowserError("INVALID_BROWSER_REQUEST", "Private network origin is invalid");
    this.locallyApprovedPrivateOrigins.add(normalized);
  }

  clearAdvancedRules(): void {
    this.requestRules = [];
    this.responseRules = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      pending.callback(false);
      this.options.emit({ type: "permission-resolved", requestId: pending.request.id });
    }
    this.pendingPermissions.clear();
    this.permissionGrants.clear();
    this.locallyApprovedPrivateOrigins.clear();
    this.options.session.setPermissionCheckHandler(null);
    this.options.session.setPermissionRequestHandler(null);
    this.options.session.webRequest.onBeforeRequest(null);
    this.options.session.webRequest.onBeforeSendHeaders(null);
    this.options.session.webRequest.onHeadersReceived(null);
  }

  private install(): void {
    const { session } = this.options;
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (!webContents) return false;
      const key = permissionKey(webContents, permission, requestingOrigin);
      return this.permissionGrants.peek(key);
    });
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (this.disposed) return callback(false);
      const tab = this.options.getTabForWebContents(webContents.id);
      if (!tab || !tab.visible || !isPromptablePermission(permission)) return callback(false);
      const origin = safeOrigin(details.requestingUrl || webContents.getURL());
      if (!origin) return callback(false);
      const key = permissionKey(webContents, permission, origin);
      if (this.permissionGrants.consume(key)) return callback(true);

      const id = randomUUID();
      const request: BrowserPermissionRequest = {
        id,
        tabId: tab.tabId,
        profileId: this.options.profileId,
        origin,
        permission,
        userGesture: permission === "fullscreen" || permission === "pointerLock",
        expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
      };
      const timer = setTimeout(() => {
        const pending = this.pendingPermissions.get(id);
        if (!pending) return;
        this.pendingPermissions.delete(id);
        pending.callback(false);
        this.options.emit({ type: "permission-resolved", requestId: id });
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(id, { request, callback, timer, key });
      this.options.emit({ type: "permission-request", request });
    });

    session.webRequest.onBeforeRequest((details, callback) => {
      if (this.disposed || details.url === "about:blank") return callback({ cancel: false });
      void this.policy
        .check(details.url, {
          settings: this.options.getNavigationSettings(),
          allowAboutBlank: true,
          userApprovedPrivateNetwork: this.locallyApprovedPrivateOrigins.has(safeOrigin(details.url) ?? ""),
        })
        .then(() => callback({ cancel: false }))
        .catch((error: unknown) => {
          const browserError =
            error instanceof BrowserError ? error : new BrowserError("NAVIGATION_BLOCKED", "Request blocked");
          this.options.onBlockedRequest?.(details.url, browserError.code);
          callback({ cancel: true });
        });
    });
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      let requestHeaders = applyHeaderRules(
        details.requestHeaders,
        this.requestRules,
        details.url,
        details.resourceType,
        this.options.resolveSecret,
      );
      const identity =
        typeof details.webContentsId === "number"
          ? this.options.getIdentityForWebContents(details.webContentsId)
          : undefined;
      if (identity && identity.mode !== "native") {
        requestHeaders = applyIdentityHeaders(requestHeaders, identity);
      }
      callback({ requestHeaders });
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      const original = details.responseHeaders ?? {};
      const advanced = this.options.getAdvancedRuntimePolicy();
      let responseHeaders = applyHeaderRules(
        original,
        this.responseRules,
        details.url,
        details.resourceType,
        this.options.resolveSecret,
      );
      if (advanced.enabled && advanced.removeSiteSecurityHeaders) {
        responseHeaders = Object.fromEntries(
          Object.entries(responseHeaders).filter(([header]) => !isUnsafeRemovedHeader(header)),
        );
      }
      callback({ responseHeaders });
    });
  }
}

function permissionKey(webContents: WebContents, permission: string, requestingOrigin: string): string {
  void webContents;
  return `${safeOrigin(requestingOrigin) ?? "invalid"}\0${permission}`;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isPromptablePermission(permission: string): boolean {
  return permission === "fullscreen" || permission === "pointerLock" || permission === "clipboard-sanitized-write";
}

function isUnsafeRemovedHeader(header: string): boolean {
  const normalized = header.toLowerCase();
  return (
    normalized === "content-security-policy" ||
    normalized === "content-security-policy-report-only" ||
    normalized === "x-frame-options" ||
    normalized.startsWith("access-control-allow-")
  );
}

export function applyIdentityHeaders(
  headers: Record<string, string | string[]>,
  identity: BrowserIdentityProfile,
): Record<string, string | string[]> {
  const lowEntropy = new Map<string, string>([
    ["user-agent", identity.ua],
    ["accept-language", identity.acceptLanguage],
    ["sec-ch-ua", serializeBrands(identity.brands)],
    ["sec-ch-ua-mobile", identity.mobile ? "?1" : "?0"],
    ["sec-ch-ua-platform", quoteHeader(identity.platform)],
  ]);
  const highEntropy = new Map<string, string>([
    ["sec-ch-ua-full-version-list", serializeBrands(identity.fullVersionList)],
    ["sec-ch-ua-full-version", quoteHeader(identity.fullVersionList[0]?.version ?? "")],
    ["sec-ch-ua-platform-version", quoteHeader(identity.platformVersion)],
    ["sec-ch-ua-arch", quoteHeader(identity.architecture)],
    ["sec-ch-ua-bitness", quoteHeader(identity.bitness)],
    ["sec-ch-ua-model", quoteHeader(identity.model)],
    ["sec-ch-ua-wow64", identity.wow64 ? "?1" : "?0"],
  ]);
  const existingNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const rewritten: Record<string, string | string[]> = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !lowEntropy.has(name.toLowerCase()) && !highEntropy.has(name.toLowerCase()),
    ),
  );
  for (const [name, value] of lowEntropy) rewritten[canonicalHeaderName(name)] = value;
  for (const [name, value] of highEntropy) {
    if (existingNames.has(name)) rewritten[canonicalHeaderName(name)] = value;
  }
  return rewritten;
}

function serializeBrands(brands: BrowserIdentityProfile["brands"]): string {
  return brands.map(({ brand, version }) => `${quoteHeader(brand)};v=${quoteHeader(version)}`).join(", ");
}

function quoteHeader(value: string): string {
  return JSON.stringify(value.replace(/[\0\r\n]/g, "").slice(0, 256));
}

function canonicalHeaderName(name: string): string {
  return name
    .split("-")
    .map((part) => (part === "ua" ? "UA" : part === "ch" ? "CH" : part[0]?.toUpperCase() + part.slice(1)))
    .join("-");
}
