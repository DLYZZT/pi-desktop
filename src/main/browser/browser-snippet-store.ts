import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserPageSnippet, BrowserPageSnippetPage, BrowserPageSnippetSummary } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const STORE_VERSION = 1 as const;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_SNIPPETS = 2_000;
const MAX_CODE_BYTES = 256 * 1024;

type StoredSnippet = Omit<BrowserPageSnippet, "untrustedWebContent" | "codeBytes"> & {
  codeHash: string;
};
type PersistedSnippet = Omit<StoredSnippet, "enabled"> & { enabled?: boolean };

type SnippetFile = {
  version: typeof STORE_VERSION;
  snippets: StoredSnippet[];
};

export class BrowserSnippetStore {
  private readonly filePath: string;
  private readonly maxPerHost: () => number;
  private loaded = false;
  private readonly snippets = new Map<string, StoredSnippet>();

  constructor(filePath: string, maxPerHost: () => number) {
    this.filePath = filePath;
    this.maxPerHost = maxPerHost;
  }

  save(input: { pageUrl: string; label: string; code: string; resultPreview?: string }): BrowserPageSnippetSummary {
    this.ensureLoaded();
    const page = parsePageUrl(input.pageUrl);
    const label = sanitizeText(input.label, 200, "Snippet purpose");
    const code = normalizeCode(input.code);
    assertSnippetSafe(code);
    const codeHash = createHash("sha256").update(code).digest("hex");
    const now = new Date().toISOString();
    const existing = [...this.snippets.values()].find(
      (snippet) => snippet.host === page.host && snippet.codeHash === codeHash,
    );
    if (existing) {
      existing.enabled = true;
      existing.label = label;
      existing.pathPattern = page.pathname;
      existing.resultPreview = sanitizeOptionalText(input.resultPreview, 200);
      existing.useCount += 1;
      existing.updatedAt = now;
      this.persist();
      return publicSummary(existing);
    }
    const snippet: StoredSnippet = {
      id: randomUUID(),
      enabled: true,
      host: page.host,
      pathPattern: page.pathname,
      label,
      code,
      codeHash,
      ...(input.resultPreview ? { resultPreview: sanitizeOptionalText(input.resultPreview, 200) } : {}),
      useCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.snippets.set(snippet.id, snippet);
    this.enforceCapacity();
    this.persist();
    return publicSummary(snippet);
  }

  listForUrl(pageUrl: string, limit = 40): BrowserPageSnippetPage {
    this.ensureLoaded();
    const page = parsePageUrl(pageUrl);
    const candidates = [...this.snippets.values()]
      .filter((snippet) => snippet.host === page.host)
      .filter((snippet) => snippet.enabled)
      .sort((left, right) => {
        const leftExact = left.pathPattern === page.pathname ? 1 : 0;
        const rightExact = right.pathPattern === page.pathname ? 1 : 0;
        return (
          rightExact - leftExact || right.useCount - left.useCount || right.updatedAt.localeCompare(left.updatedAt)
        );
      });
    return {
      snippets: candidates.slice(0, clamp(limit, 1, 100)).map(publicSummary),
      siteCount: candidates.length,
      untrustedWebContent: true,
    };
  }

  getForUrl(pageUrl: string, id: string, offset = 0, maxChars = 4_000): BrowserPageSnippet {
    this.ensureLoaded();
    const page = parsePageUrl(pageUrl);
    const snippet = this.snippets.get(validateId(id));
    if (!snippet || !snippet.enabled || snippet.host !== page.host) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser page snippet was not found for this site");
    }
    const start = clamp(offset, 0, snippet.code.length);
    const count = clamp(maxChars, 1, 4_000);
    snippet.useCount += 1;
    snippet.updatedAt = new Date().toISOString();
    this.persist();
    return {
      ...publicSummary(snippet),
      code: snippet.code.slice(start, start + count),
    };
  }

  listAll(): BrowserPageSnippetSummary[] {
    this.ensureLoaded();
    return [...this.snippets.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicSummary);
  }

  delete(id: string): void {
    this.ensureLoaded();
    if (this.snippets.delete(validateId(id))) this.persist();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.ensureLoaded();
    if (typeof enabled !== "boolean") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser snippet enabled state is invalid");
    }
    const snippet = this.snippets.get(validateId(id));
    if (!snippet) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser page snippet was not found");
    snippet.enabled = enabled;
    snippet.updatedAt = new Date().toISOString();
    this.persist();
  }

  clear(): void {
    this.ensureLoaded();
    this.snippets.clear();
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Best effort; an empty store is also persisted on the next save.
    }
  }

  count(): number {
    this.ensureLoaded();
    return this.snippets.size;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stats = fs.statSync(this.filePath);
      if (!stats.isFile() || stats.size > MAX_STORE_BYTES) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SnippetFile>;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.snippets)) return;
      for (const candidate of parsed.snippets.slice(0, MAX_SNIPPETS)) {
        if (!isStoredSnippet(candidate)) continue;
        try {
          assertSnippetSafe(candidate.code);
          this.snippets.set(candidate.id, { ...candidate, enabled: candidate.enabled !== false });
        } catch {
          // Corrupt or newly disallowed entries are skipped without echoing source.
        }
      }
      this.enforceCapacity();
    } catch {
      this.snippets.clear();
    }
  }

  private enforceCapacity(): void {
    const perHost = clamp(this.maxPerHost(), 5, 200);
    const byHost = new Map<string, StoredSnippet[]>();
    for (const snippet of this.snippets.values()) {
      const group = byHost.get(snippet.host) ?? [];
      group.push(snippet);
      byHost.set(snippet.host, group);
    }
    for (const group of byHost.values()) {
      group
        .sort(evictionOrder)
        .slice(0, Math.max(0, group.length - perHost))
        .forEach((snippet) => this.snippets.delete(snippet.id));
    }
    [...this.snippets.values()]
      .sort(evictionOrder)
      .slice(0, Math.max(0, this.snippets.size - MAX_SNIPPETS))
      .forEach((snippet) => this.snippets.delete(snippet.id));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data: SnippetFile = { version: STORE_VERSION, snippets: [...this.snippets.values()] };
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Windows does not expose POSIX modes.
      }
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Best effort temporary-file cleanup.
      }
    }
  }
}

export function assertSnippetSafe(code: string): void {
  if (!code || Buffer.byteLength(code) > MAX_CODE_BYTES || code.includes("\0")) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser snippet source is invalid");
  }
  const forbidden = [
    /\bdocument\s*\.\s*cookie\b/i,
    /\b(?:localStorage|sessionStorage|indexedDB)\b/i,
    /\b(?:authorization|proxy-authorization|set-cookie)\b/i,
    /\b(?:bearer|api[_-]?key|private[_-]?key|client[_-]?secret)\b/i,
    /querySelector(?:All)?\s*\(\s*['"`][^'"`]*(?:password|one-time-code|cc-number|cc-csc)/i,
    /\b(?:password|otp|creditcard|cardnumber)\s*[:=]\s*['"`][^'"`]+/i,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^'"`\s/\\]+/i,
  ];
  if (forbidden.some((pattern) => pattern.test(code))) {
    throw new BrowserError("PERMISSION_DENIED", "Browser snippet was not saved because it may access secrets");
  }
  if (/[A-Za-z0-9+/=_-]{80,}/.test(code)) {
    throw new BrowserError("PERMISSION_DENIED", "Browser snippet was not saved because it contains secret-like data");
  }
}

function publicSummary(snippet: StoredSnippet): BrowserPageSnippetSummary {
  return {
    id: snippet.id,
    enabled: snippet.enabled,
    host: snippet.host,
    pathPattern: snippet.pathPattern,
    label: snippet.label,
    ...(snippet.resultPreview ? { resultPreview: snippet.resultPreview } : {}),
    useCount: snippet.useCount,
    createdAt: snippet.createdAt,
    updatedAt: snippet.updatedAt,
    codeBytes: Buffer.byteLength(snippet.code),
    untrustedWebContent: true,
  };
}

function parsePageUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported");
    return url;
  } catch {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser page URL is unavailable");
  }
}

function normalizeCode(value: string): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim();
}

function sanitizeText(value: string, maxLength: number, label: string): string {
  const normalized = value
    .trim()
    .replace(/[\0\r\n]+/g, " ")
    .slice(0, maxLength);
  if (!normalized) throw new BrowserError("INVALID_BROWSER_REQUEST", `${label} is required`);
  return normalized;
}

function sanitizeOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\0\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

function validateId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser snippet id is invalid");
  }
  return value;
}

function isStoredSnippet(value: unknown): value is PersistedSnippet {
  if (!value || typeof value !== "object") return false;
  const snippet = value as Partial<PersistedSnippet>;
  return (
    typeof snippet.id === "string" &&
    (snippet.enabled === undefined || typeof snippet.enabled === "boolean") &&
    typeof snippet.host === "string" &&
    typeof snippet.pathPattern === "string" &&
    typeof snippet.label === "string" &&
    typeof snippet.code === "string" &&
    typeof snippet.codeHash === "string" &&
    typeof snippet.useCount === "number" &&
    typeof snippet.createdAt === "string" &&
    typeof snippet.updatedAt === "string"
  );
}

function evictionOrder(left: StoredSnippet, right: StoredSnippet): number {
  return left.useCount - right.useCount || left.updatedAt.localeCompare(right.updatedAt);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
