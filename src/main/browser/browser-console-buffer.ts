import { randomUUID } from "node:crypto";
import type { BrowserConsoleEntry, BrowserConsoleLevel, BrowserConsolePage } from "../../contract/browser.ts";
import type { BrowserCdpCoordinator, BrowserCdpEvent } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { redactBrowserText, redactBrowserUrl } from "./browser-redaction.ts";

type ConsoleWaiter = {
  afterSequence: number;
  levels: Set<BrowserConsoleLevel>;
  resolve: (entry: BrowserConsoleEntry) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserConsoleBuffer {
  private readonly tabId: string;
  private readonly cdp: BrowserCdpCoordinator;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, BrowserConsoleEntry>();
  private readonly waiters = new Set<ConsoleWaiter>();
  private sequence = 0;
  private unsubscribe?: () => void;
  private releaseRuntime?: () => Promise<void>;
  private releaseLog?: () => Promise<void>;
  private started = false;

  constructor(tabId: string, cdp: BrowserCdpCoordinator, maxEntries = 500, now: () => number = Date.now) {
    this.tabId = tabId;
    this.cdp = cdp;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribe = this.cdp.subscribe(this.tabId, (event) => this.handleEvent(event));
    try {
      this.releaseRuntime = await this.cdp.enableDomain(this.tabId, "Runtime");
      this.releaseLog = await this.cdp.enableDomain(this.tabId, "Log");
      this.started = true;
    } catch (error) {
      await this.releaseRuntime?.().catch(() => undefined);
      this.releaseRuntime = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const releaseRuntime = this.releaseRuntime;
    const releaseLog = this.releaseLog;
    this.releaseRuntime = undefined;
    this.releaseLog = undefined;
    if (releaseLog) await releaseLog().catch(() => undefined);
    if (releaseRuntime) await releaseRuntime().catch(() => undefined);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new BrowserError("CAPABILITY_DISABLED", "Browser Console capture was disabled"));
    }
    this.waiters.clear();
    this.entries.clear();
  }

  list(input: { after?: string; levels?: BrowserConsoleLevel[]; limit?: number }): BrowserConsolePage {
    const afterSequence = this.resolveCursor(input.after);
    const levels = normalizeLevels(input.levels);
    const limit = clamp(input.limit ?? 50, 1, 200);
    const matches = [...this.entries.values()].filter(
      (entry) => entry.sequence > afterSequence && (levels.size === 0 || levels.has(entry.level)),
    );
    const page = matches.slice(0, limit);
    return {
      entries: page.map((entry) => structuredClone(entry)),
      ...(matches.length > page.length && page.length ? { nextCursor: page[page.length - 1]!.id } : {}),
      truncated: matches.length > page.length,
      untrustedWebContent: true,
    };
  }

  wait(
    input: { after?: string; levels?: BrowserConsoleLevel[]; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<BrowserConsoleEntry> {
    const afterSequence = input.after ? this.resolveCursor(input.after) : this.sequence;
    const levels = normalizeLevels(input.levels);
    const existing = [...this.entries.values()].find(
      (entry) => entry.sequence > afterSequence && (levels.size === 0 || levels.has(entry.level)),
    );
    if (existing) return Promise.resolve(structuredClone(existing));
    const timeoutMs = clamp(input.timeoutMs ?? 30_000, 50, 120_000);
    return new Promise((resolve, reject) => {
      const waiter: ConsoleWaiter = {
        afterSequence,
        levels,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new BrowserError("ACTION_TIMEOUT", "Waiting for a Browser Console entry timed out"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          reject(new BrowserError("USER_TOOK_CONTROL", "Browser Console wait was cancelled"));
        },
        { once: true },
      );
    });
  }

  count(): number {
    return this.entries.size;
  }

  private handleEvent(event: BrowserCdpEvent): void {
    if (event.method === "Runtime.consoleAPICalled") {
      const type = asString(event.params.type, 32);
      const args = Array.isArray(event.params.args) ? event.params.args : [];
      const stack = stackFrom(event.params.stackTrace);
      this.add({
        level: consoleLevel(type),
        text: args.map(remoteObjectText).filter(Boolean).join(" ").slice(0, 4_096) || type || "console",
        source: stack.source,
        line: stack.line,
        column: stack.column,
        stack: stack.text,
        timestamp: asTimestamp(event.params.timestamp, this.now()),
      });
      return;
    }
    if (event.method === "Runtime.exceptionThrown") {
      const details = asRecord(event.params.exceptionDetails);
      const exception = asRecord(details.exception);
      const stack = stackFrom(details.stackTrace);
      this.add({
        level: "error",
        text:
          asString(exception.description, 4_096) || asString(details.text, 4_096) || "Unhandled JavaScript exception",
        source: stack.source || asString(details.url, 8_192),
        line: asOptionalNumber(details.lineNumber),
        column: asOptionalNumber(details.columnNumber),
        stack: stack.text,
        timestamp: asTimestamp(event.params.timestamp, this.now()),
      });
      return;
    }
    if (event.method === "Log.entryAdded") {
      const entry = asRecord(event.params.entry);
      this.add({
        level: consoleLevel(asString(entry.level, 32)),
        text: asString(entry.text, 4_096) || "Browser log entry",
        source: asString(entry.url, 8_192) || asString(entry.source, 256),
        line: asOptionalNumber(entry.lineNumber),
        timestamp: asTimestamp(entry.timestamp, this.now()),
      });
    }
  }

  private add(input: Omit<BrowserConsoleEntry, "id" | "sequence" | "untrustedWebContent">): void {
    const entry: BrowserConsoleEntry = {
      ...input,
      id: randomUUID(),
      sequence: ++this.sequence,
      text: redactBrowserText(input.text, 4_096),
      source: input.source.startsWith("http") ? redactBrowserUrl(input.source, 2_048) : input.source.slice(0, 256),
      ...(input.stack ? { stack: redactBrowserText(input.stack, 8_192) } : {}),
      untrustedWebContent: true,
    };
    this.entries.set(entry.id, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    for (const waiter of [...this.waiters]) {
      if (entry.sequence <= waiter.afterSequence || (waiter.levels.size && !waiter.levels.has(entry.level))) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(structuredClone(entry));
    }
  }

  private resolveCursor(cursor?: string): number {
    if (!cursor) return 0;
    const entry = this.entries.get(cursor);
    if (!entry) throw new BrowserError("CONSOLE_CURSOR_EXPIRED", "Browser Console cursor expired");
    return entry.sequence;
  }
}

function normalizeLevels(levels?: BrowserConsoleLevel[]): Set<BrowserConsoleLevel> {
  if (!levels) return new Set();
  if (!Array.isArray(levels) || levels.length > 4) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser Console levels are invalid");
  }
  const allowed = new Set<BrowserConsoleLevel>(["error", "warning", "info", "debug"]);
  if (levels.some((level) => !allowed.has(level))) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser Console levels are invalid");
  }
  return new Set(levels);
}

function consoleLevel(value: string): BrowserConsoleLevel {
  if (value === "error" || value === "assert") return "error";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "debug" || value === "verbose") return "debug";
  return "info";
}

function remoteObjectText(value: unknown): string {
  const object = asRecord(value);
  const primitive = object.value;
  if (
    primitive === null ||
    typeof primitive === "string" ||
    typeof primitive === "number" ||
    typeof primitive === "boolean"
  ) {
    return String(primitive).slice(0, 2_048);
  }
  return (asString(object.description, 2_048) || asString(object.type, 64)).slice(0, 2_048);
}

function stackFrom(value: unknown): {
  source: string;
  line?: number;
  column?: number;
  text?: string;
} {
  const stack = asRecord(value);
  const frames = Array.isArray(stack.callFrames) ? stack.callFrames.slice(0, 20) : [];
  const normalized = frames.map((frame) => {
    const item = asRecord(frame);
    return {
      functionName: asString(item.functionName, 256) || "<anonymous>",
      url: asString(item.url, 8_192),
      lineNumber: asOptionalNumber(item.lineNumber),
      columnNumber: asOptionalNumber(item.columnNumber),
    };
  });
  const first = normalized[0];
  return {
    source: first?.url ?? "",
    ...(first?.lineNumber === undefined ? {} : { line: first.lineNumber }),
    ...(first?.columnNumber === undefined ? {} : { column: first.columnNumber }),
    ...(normalized.length
      ? {
          text: normalized
            .map(
              (frame) =>
                `${frame.functionName} (${frame.url || "unknown"}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0})`,
            )
            .join("\n"),
        }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function asTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
